// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import type { RunRow } from "./runs";

// Spawns the worker for a run and returns a truthy "pid" on success or null on
// failure. May be async (the Docker API is): dispatchRun awaits it.
export type SpawnFn = (runId: number, scope: string) => number | null | Promise<number | null>;

// Late-bound bridge back into lib/runs (avoids a static import cycle; runs.ts
// injects these on load). See the longer note kept from the systemd era.
type RunsApi = {
  get: (id: number) => Promise<RunRow | null>;
  isLeaseLive: (run: { status: string; heartbeatAt: Date | null }, now?: number) => boolean;
  /** Mark a run failed with an error (updates status + emits a status event). */
  failRun: (runId: number, error: string) => Promise<void>;
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

let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return `${process.pid}-${nonceCounter}`;
}

export async function dispatchRun(
  runId: number,
  opts: { spawn?: SpawnFn } = {}
): Promise<"spawned" | "already-claimed" | "not-found" | "spawn-failed"> {
  const run = await runs().get(runId);
  if (!run) return "not-found";
  if (runs().isLeaseLive(run)) return "already-claimed";
  if (run.workerScope) return "already-claimed";

  const scope = `run-${runId}-${nonce()}`;
  // Atomic claim: only succeeds if worker_scope is still NULL.
  const claimed = await db
    .update(agentSessions)
    .set({ status: "preparing", workerScope: scope, cancelRequested: 0, heartbeatAt: new Date() })
    .where(and(eq(agentSessions.id, runId), isNull(agentSessions.workerScope)));
  if (claimed.count === 0) return "already-claimed";

  // Spawn the worker. A throw or a null pid must NOT leave the run wedged in
  // 'preparing' with no error — mark it failed and release the claim.
  const spawn = opts.spawn ?? defaultSpawn;
  let pid: number | null = null;
  try {
    pid = await spawn(runId, scope);
  } catch (err) {
    return await failSpawn(runId, `run worker failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pid == null) {
    return await failSpawn(runId, "run worker did not start (spawn returned no pid — worker image/runtime available?)");
  }
  await db.update(agentSessions).set({ workerPid: pid }).where(eq(agentSessions.id, runId));
  return "spawned";
}

async function failSpawn(runId: number, message: string): Promise<"spawn-failed"> {
  await db.update(agentSessions).set({ workerScope: null, workerPid: null }).where(eq(agentSessions.id, runId));
  await runs().failRun(runId, message);
  return "spawn-failed";
}

// Worker execution runs in its own process/container so a web-service restart or
// redeploy cannot signal it. Prefer an ad-hoc Docker container (TASK_ORCH_WORKER_IMAGE
// set — the compose/prod path); fall back to a plain detached tsx process for dev.
export const defaultSpawn: SpawnFn = async (runId, scope) => {
  if (process.env.TASK_ORCH_WORKER_IMAGE) return dockerSpawn(runId, scope);
  return detachedSpawn(runId, scope);
};

// One worker container per run, launched via the mounted Docker socket. The
// container connects to Postgres over the compose network, checks out from the
// repo-cache volume, and pushes to GitHub with GH_TOKEN. workerScope is the
// container name; liveness is heartbeat-based; cancel() calls stopWorkerContainer.
async function dockerSpawn(runId: number, scope: string): Promise<number | null> {
  const { default: Docker } = await import("dockerode");
  const docker = new Docker();
  const image = process.env.TASK_ORCH_WORKER_IMAGE!;
  const pass = (k: string) => `${k}=${process.env[k] ?? ""}`;
  const env = [
    pass("DATABASE_URL"),
    pass("GH_TOKEN"),
    pass("CLAUDE_CODE_OAUTH_TOKEN"),
    pass("ANTHROPIC_API_KEY"),
    pass("TASK_ORCH_AGENT_BACKEND"),
    pass("TASK_ORCH_CHAT_MODEL"),
    pass("TASK_ORCH_AGENT_MODEL"),
    "TASK_ORCH_DETACHED_RUNS=1",
    // Signals the in-container checkout strategy (Phase 5): clone from the
    // mounted repo-cache mirror instead of a host worktree.
    "REPO_CACHE_DIR=/repo-cache",
  ];
  const binds: string[] = [];
  const claudeHome = process.env.TASK_ORCH_CLAUDE_HOME_HOST;
  if (claudeHome) binds.push(`${claudeHome}:/root/.claude`);
  const repoCacheVol = process.env.TASK_ORCH_REPO_CACHE_HOST_VOLUME;
  if (repoCacheVol) binds.push(`${repoCacheVol}:/repo-cache`);

  const container = await docker.createContainer({
    Image: image,
    name: scope,
    Cmd: [String(runId)],
    Env: env,
    HostConfig: {
      AutoRemove: true,
      Binds: binds,
      ...(process.env.TASK_ORCH_DOCKER_NETWORK
        ? { NetworkMode: process.env.TASK_ORCH_DOCKER_NETWORK }
        : {}),
    },
  });
  await container.start();
  return 1; // sentinel: container started (not a host pid). cancel() uses the name.
}

// Dev fallback: a detached `tsx scripts/run-worker.ts <id>` on the host, talking
// to the same DATABASE_URL. No restart-survival, but dev doesn't redeploy.
function detachedSpawn(runId: number, _scope: string): number | null {
  const node = process.execPath;
  const tsx =
    process.env.TASK_ORCH_TSX_CLI || join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsx)) throw new Error(`tsx CLI not found at ${tsx} (set TASK_ORCH_TSX_CLI to override)`);
  const child = nodeSpawn(node, [tsx, "scripts/run-worker.ts", String(runId)], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

/** Best-effort hard stop of a run's worker container (cancel fallback). No-op if
 *  not containerized or the container is already gone. */
export async function stopWorkerContainer(scope: string | null): Promise<void> {
  if (!scope || !process.env.TASK_ORCH_WORKER_IMAGE) return;
  try {
    const { default: Docker } = await import("dockerode");
    const docker = new Docker();
    await docker.getContainer(scope).stop({ t: 5 });
  } catch {
    // already stopped / removed / unreachable — nothing to do
  }
}
