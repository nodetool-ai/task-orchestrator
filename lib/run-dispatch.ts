// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import type { RunRow } from "./runs";

export type SpawnFn = (runId: number, scope: string) => number | null;

// Late-bound bridge back into lib/runs. run-dispatch needs get()/isLeaseLive()
// synchronously, but a *static* `import { get, isLeaseLive } from "./runs"` here
// forms a runs ↔ run-dispatch import cycle that webpack minification turns into a
// boot-time TDZ ("Cannot access 'r' before initialization"). runs.ts imports this
// module (namespace) and injects the two helpers on load, so the only static edge
// is runs → run-dispatch (no cycle). A function-scoped `require("./runs")` — the
// plan's original suggestion — would work in the prod bundle but throws under the
// Vitest ESM loader (native require can't resolve the .ts source), so injection is
// used instead.
type RunsApi = {
  get: (id: number) => RunRow | null;
  isLeaseLive: (run: { status: string; heartbeatAt: Date | null }, now?: number) => boolean;
  /** Mark a run failed with an error (updates status + emits a status event). */
  failRun: (runId: number, error: string) => void;
};
let runsApi: RunsApi | null = null;
export function __setRunsApi(api: RunsApi): void {
  runsApi = api;
}
function runs(): RunsApi {
  if (!runsApi) throw new Error("run-dispatch: runs API not initialized");
  return runsApi;
}

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
): "spawned" | "already-claimed" | "not-found" | "spawn-failed" {
  const run = runs().get(runId);
  if (!run) return "not-found";
  if (runs().isLeaseLive(run)) return "already-claimed";
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

  // Spawn the detached worker. A spawn that throws (bad module resolution in the
  // prod bundle) OR returns no pid (executable not found) must NOT leave the run
  // wedged in 'preparing' forever with no error — mark it failed and release the
  // claim so the failure is visible in the UI and the run can be retried.
  const spawn = opts.spawn ?? defaultSpawn;
  let pid: number | null = null;
  try {
    pid = spawn(runId, scope);
  } catch (err) {
    return failSpawn(runId, `run worker failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pid == null) {
    return failSpawn(runId, "run worker did not start (spawn returned no pid — is the worker runtime installed?)");
  }
  db.update(agentSessions).set({ workerPid: pid }).where(eq(agentSessions.id, runId)).run();
  return "spawned";
}

function failSpawn(runId: number, message: string): "spawn-failed" {
  // Release the claim so a later dispatch/retry can re-acquire it, then fail.
  db.update(agentSessions).set({ workerScope: null, workerPid: null }).where(eq(agentSessions.id, runId)).run();
  runs().failRun(runId, message);
  return "spawn-failed";
}

// M1: launch the worker in its own transient systemd --user scope so a
// `systemctl restart` of the web unit cannot signal it. Falls back to a
// plain detached spawn (dev / no systemd-run). Returns the child pid.
export const defaultSpawn: SpawnFn = (runId, scope) => {
  const node = process.execPath;
  // Resolve tsx's CLI by filesystem path, NOT require.resolve/createRequire.
  // Inside the Next/webpack prod server bundle those get rewritten to webpack's
  // own module resolver, which can't see node_modules and throws "Cannot find
  // module 'tsx/cli'" at runtime — wedging the run. `join(cwd, …)` is a plain
  // runtime path lookup webpack never transforms. cwd is the repo root (same
  // assumption the relative worker path below already relies on). Override with
  // TASK_ORCH_TSX_CLI if tsx's internal layout ever moves.
  const tsx =
    process.env.TASK_ORCH_TSX_CLI ||
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsx)) {
    throw new Error(`tsx CLI not found at ${tsx} (set TASK_ORCH_TSX_CLI to override)`);
  }
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
  // A child_process 'error' (ENOENT on cmd, etc.) with no listener is emitted as
  // an unhandled 'error' that would crash the server. Swallow it; the failure
  // surfaces as a null pid (handled by dispatchRun) instead.
  child.on("error", () => {});
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
