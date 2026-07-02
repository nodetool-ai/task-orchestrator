// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { get, isLeaseLive } from "./runs";

export type SpawnFn = (runId: number, scope: string) => number | null;

export function detachedRunsEnabled(): boolean {
  const v = process.env.TASK_ORCH_DETACHED_RUNS;
  return !!v && v !== "0" && v.toLowerCase() !== "false";
}

// Monotonic per-process nonce (Math.random is unavailable in some sandboxes;
// a counter + pid is unique enough for a scope unit name).
let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return `${process.pid}-${nonceCounter}`;
}

export function dispatchRun(
  runId: number,
  opts: { spawn?: SpawnFn } = {}
): "spawned" | "already-claimed" | "not-found" {
  const run = get(runId);
  if (!run) return "not-found";
  if (isLeaseLive(run)) return "already-claimed";
  if (run.workerScope) return "already-claimed";

  const scope = `run-${runId}-${nonce()}`;
  // Atomic claim: only succeeds if worker_scope is still NULL. A concurrent
  // claimer that wins flips it non-null, so our WHERE matches 0 rows and we bail.
  const claimed = db
    .update(agentSessions)
    .set({ status: "preparing", workerScope: scope, cancelRequested: 0, heartbeatAt: new Date() })
    .where(and(eq(agentSessions.id, runId), isNull(agentSessions.workerScope)))
    .run();
  if (claimed.changes === 0) return "already-claimed";

  const spawn = opts.spawn ?? defaultSpawn;
  const pid = spawn(runId, scope);
  if (pid != null) {
    db.update(agentSessions).set({ workerPid: pid }).where(eq(agentSessions.id, runId)).run();
  }
  return "spawned";
}

// M1: launch the worker in its own transient systemd --user scope so a
// `systemctl restart` of the web unit cannot signal it. Falls back to a
// plain detached spawn (dev / no systemd-run). Returns the child pid.
export const defaultSpawn: SpawnFn = (runId, scope) => {
  const require = createRequire(import.meta.url);
  const node = process.execPath;
  const tsx = require.resolve("tsx/cli");
  const worker = "scripts/run-worker.ts";
  const useSystemd = process.platform === "linux" && hasSystemdRun();
  const cmd = useSystemd ? "systemd-run" : node;
  const args = useSystemd
    ? ["--user", "--scope", "--collect", `--unit=${scope}`, "--", node, tsx, worker, String(runId)]
    : [tsx, worker, String(runId)];
  const child = nodeSpawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
};

function hasSystemdRun(): boolean {
  try {
    execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
