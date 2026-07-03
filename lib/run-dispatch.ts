// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import type { RunRow } from "./runs";

// Spawns the worker for a run and returns a truthy "pid" on success or null on
// failure. May be async (the Docker API is): dispatchRun awaits it.
export type SpawnFn = (runId: number, scope: string) => number | null | Promise<number | null>;

/** Admission decision for a run about to be dispatched. */
export type AdmitDecision = "admit" | "defer" | "never-fits";
/** Injectable admission check (tests override it; defaults to `admit`). */
export type AdmitFn = (runId: number) => AdmitDecision | Promise<AdmitDecision>;

export type DispatchResult =
  | "spawned"
  | "already-claimed"
  | "not-found"
  | "spawn-failed"
  | "deferred";

// Late-bound bridge back into lib/runs (avoids a static import cycle; runs.ts
// injects these on load). See the longer note kept from the systemd era.
type RunsApi = {
  get: (id: number) => Promise<RunRow | null>;
  isLeaseLive: (run: { status: string; heartbeatAt: Date | null }, now?: number) => boolean;
  /** Mark a run failed with an error (updates status + emits a status event). */
  failRun: (runId: number, error: string) => Promise<void>;
  /** Count runs holding a worker slot (worker_scope set + a lease status). */
  countInFlightWorkers: () => Promise<number>;
  /** Ids of runs parked in 'pending', oldest first (the dispatch queue). */
  listPendingRunIds: () => Promise<number[]>;
  /** Reap stale leases (OOM-killed / dead workers); re-dispatches resumable ones. */
  reconcileOrphanedRuns: () => Promise<number>;
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

// ── env helpers ────────────────────────────────────────────────────────────
function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
}
function floatEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// ── per-worker resource caps ───────────────────────────────────────────────
// Hard cgroup limits applied to each worker container at create time. Every knob
// is opt-in: an unset/0 value omits its field, so deploys without config keep
// today's (unlimited) behavior. Values are read fresh each spawn so a restart
// picks up config changes.
export function buildWorkerLimits(): Record<string, number> {
  const memMB = intEnv("TASK_ORCH_WORKER_MEMORY_MB", 0);
  const swapMB = intEnv("TASK_ORCH_WORKER_MEMORY_SWAP_MB", 0);
  const resvMB = intEnv("TASK_ORCH_WORKER_MEMORY_RESERVATION_MB", 0);
  const cpu = floatEnv("TASK_ORCH_WORKER_CPUS", 0);
  const pids = intEnv("TASK_ORCH_WORKER_PIDS_LIMIT", 0);
  const limits: Record<string, number> = {};
  if (memMB > 0) {
    const mem = memMB * 1024 * 1024;
    limits.Memory = mem;
    // MemorySwap must be >= Memory. Default it EQUAL to Memory to disable
    // per-container swap: if it's left unset Docker defaults it to 2x Memory and
    // the worker silently swaps under pressure instead of being capped — and swap
    // thrash stalls the 20s heartbeat past the stale window, so a still-live
    // worker gets falsely reaped as an orphan.
    limits.MemorySwap = swapMB > 0 ? Math.max(swapMB * 1024 * 1024, mem) : mem;
    // Soft low-watermark the kernel reclaims toward under host pressure (no kill).
    // Must be <= Memory or createContainer rejects; clamp defensively.
    if (resvMB > 0) limits.MemoryReservation = Math.min(resvMB * 1024 * 1024, mem);
  }
  if (cpu > 0) {
    const ncpu = cpus().length || 1;
    limits.NanoCpus = Math.floor(Math.min(cpu, ncpu) * 1e9);
  }
  if (pids > 0) limits.PidsLimit = pids;
  return limits;
}

// ── host memory / admission gate ───────────────────────────────────────────
type HostMem = { memTotalMB: number; memAvailableMB: number | null };

// Host size + whether /proc/meminfo can be trusted are stable for the process'
// lifetime; cache them (a vertically-resized host needs a restart to re-read).
let hostInfoCache: { memTotalMB: number; ncpu: number; meminfoTrustworthy: boolean } | null = null;

function readMeminfoMB(key: "MemTotal" | "MemAvailable"): number | null {
  try {
    const txt = readFileSync("/proc/meminfo", "utf8");
    const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    if (!m) return null;
    return Math.floor(Number(m[1]) / 1024);
  } catch {
    return null;
  }
}

async function getHostInfo(): Promise<{ memTotalMB: number; ncpu: number; meminfoTrustworthy: boolean }> {
  if (hostInfoCache) return hostInfoCache;
  // os.totalmem() is the host's physical RAM (sysinfo), not cgroup-limited, so it
  // is a safe fallback. docker.info() over the mounted socket is authoritative:
  // under Docker-out-of-Docker the daemon runs on the host, so MemTotal/NCPU are
  // always host figures regardless of any limit on the server container itself.
  let memTotalMB = Math.floor(totalmem() / (1024 * 1024));
  let ncpu = cpus().length || 1;
  try {
    const { default: Docker } = await import("dockerode");
    const info = (await new Docker().info()) as { MemTotal?: number; NCPU?: number };
    if (info?.MemTotal) memTotalMB = Math.floor(Number(info.MemTotal) / (1024 * 1024));
    if (info?.NCPU) ncpu = Number(info.NCPU);
  } catch {
    // socket unreachable — fall back to os.* (still host-total here).
  }
  // Memory is not namespaced by default in Docker, and a server cgroup limit does
  // NOT rewrite /proc/meminfo unless lxcfs is mounted. Detect that rare case by
  // comparing meminfo's total against the daemon's: a >10% divergence means
  // meminfo is container-local and MemAvailable can't be trusted host-wide.
  const miTotal = readMeminfoMB("MemTotal");
  const meminfoTrustworthy =
    miTotal != null && memTotalMB > 0 && Math.abs(miTotal - memTotalMB) / memTotalMB < 0.1;
  hostInfoCache = { memTotalMB, ncpu, meminfoTrustworthy };
  return hostInfoCache;
}

/** Reset the cached host figures (tests only). */
export function __resetHostInfoCache(): void {
  hostInfoCache = null;
}

async function readHostMemory(): Promise<HostMem> {
  const info = await getHostInfo();
  let memAvailableMB: number | null = null;
  if (info.meminfoTrustworthy) memAvailableMB = readMeminfoMB("MemAvailable");
  return { memTotalMB: info.memTotalMB, memAvailableMB };
}

/**
 * Pure admission decision. Two independent bounds:
 *  - reservation accounting: host budget (total − reserve) minus each in-flight
 *    worker's full cap must still cover one more cap. This is the primary,
 *    deterministic signal (bursty agent memory makes point-in-time reads lie).
 *  - live floor: current MemAvailable − reserve must cover a cap too (skipped
 *    when /proc/meminfo isn't trustworthy). A secondary guard against surprises.
 * A single worker whose cap exceeds the whole budget can never fit → never-fits.
 */
export function admissionDecision(i: {
  capMB: number;
  reserveMB: number;
  maxWorkers: number;
  inFlight: number;
  memTotalMB: number;
  memAvailableMB: number | null;
}): AdmitDecision {
  if (i.maxWorkers > 0 && i.inFlight >= i.maxWorkers) return "defer";
  if (i.capMB > 0) {
    const budget = i.memTotalMB - i.reserveMB;
    if (i.capMB > budget) return "never-fits";
    if (budget - i.inFlight * i.capMB < i.capMB) return "defer";
    if (i.memAvailableMB != null && i.memAvailableMB - i.reserveMB < i.capMB) return "defer";
  }
  return "admit";
}

/** The gate only runs on the containerized path, and can be turned off. */
function admissionEnabled(): boolean {
  if (!process.env.TASK_ORCH_WORKER_IMAGE) return false;
  const v = process.env.TASK_ORCH_ADMISSION_ENABLED;
  return v == null || (v !== "0" && v.toLowerCase() !== "false");
}

async function admit(runId: number): Promise<AdmitDecision> {
  void runId; // reserved for future per-run sizing; decision is host-global today
  const capMB = intEnv("TASK_ORCH_WORKER_MEMORY_MB", 0);
  const reserveMB = intEnv("TASK_ORCH_HOST_MEMORY_RESERVE_MB", 0);
  const maxWorkers = intEnv("TASK_ORCH_MAX_WORKERS", 0);
  const inFlight = await runs().countInFlightWorkers();
  const host = await readHostMemory();
  return admissionDecision({
    capMB,
    reserveMB,
    maxWorkers,
    inFlight,
    memTotalMB: host.memTotalMB,
    memAvailableMB: host.memAvailableMB,
  });
}

// The admission decision + the atomic claim must be serialized: two concurrent
// dispatches must not both measure the same free memory and both admit. There is
// exactly one server process, so an in-process promise chain fully serializes it.
// (A pg_advisory_xact_lock is the drop-in upgrade if the server is ever replicated.)
let admissionChain: Promise<unknown> = Promise.resolve();
function withAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = admissionChain.then(fn, fn);
  admissionChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export async function dispatchRun(
  runId: number,
  opts: { spawn?: SpawnFn; admit?: AdmitFn } = {}
): Promise<DispatchResult> {
  const admitFn = opts.admit ?? admit;

  // Critical section: decide admission, then atomically claim. Serialized so the
  // reservation count seen by the next caller already includes this claim. The
  // spawn itself (a slow Docker round-trip) runs OUTSIDE the lock.
  const outcome = await withAdmissionLock<
    { kind: Exclude<DispatchResult, "spawned"> } | { kind: "claimed"; scope: string }
  >(async () => {
    const run = await runs().get(runId);
    if (!run) return { kind: "not-found" };
    if (runs().isLeaseLive(run)) return { kind: "already-claimed" };
    if (run.workerScope) return { kind: "already-claimed" };

    if (admissionEnabled()) {
      const decision = await admitFn(runId);
      if (decision === "never-fits") {
        await runs().failRun(
          runId,
          "insufficient host memory: a single worker's memory cap exceeds the host budget (raise the host, lower TASK_ORCH_WORKER_MEMORY_MB, or lower TASK_ORCH_HOST_MEMORY_RESERVE_MB)."
        );
        return { kind: "spawn-failed" };
      }
      if (decision === "defer") {
        // Park for the pending-run pump. 'pending' is NOT a lease status, so
        // reconcileOrphanedRuns won't fail it while it waits. Stamp the START of
        // this pending episode (heartbeatAt) ONLY on the transition INTO pending,
        // so the pump's MAX_DEFER bound measures time-in-pending — not time since
        // creation, which would instantly fail a long-running orphan re-dispatched
        // under memory pressure. Re-defers of an already-pending run must NOT reset
        // the stamp (that would let a run defer forever). A run born 'pending'
        // keeps heartbeatAt null and is bounded from startedAt (≈ its enqueue
        // time). heartbeatAt is inert on a 'pending' row (isLeaseLive/reconcile only
        // consider lease statuses), so reusing it here can't disturb liveness.
        const stampEpisode = run.status !== "pending";
        await db
          .update(agentSessions)
          .set({
            status: "pending",
            workerScope: null,
            workerPid: null,
            ...(stampEpisode ? { heartbeatAt: new Date() } : {}),
          })
          .where(eq(agentSessions.id, runId));
        return { kind: "deferred" };
      }
    }

    const scope = `run-${runId}-${nonce()}`;
    // Atomic claim: only succeeds if worker_scope is still NULL.
    const claimed = await db
      .update(agentSessions)
      .set({ status: "preparing", workerScope: scope, cancelRequested: 0, heartbeatAt: new Date() })
      .where(and(eq(agentSessions.id, runId), isNull(agentSessions.workerScope)));
    if (claimed.count === 0) return { kind: "already-claimed" };
    return { kind: "claimed", scope };
  });

  if (outcome.kind !== "claimed") return outcome.kind;

  // Spawn the worker. A throw or a null pid must NOT leave the run wedged in
  // 'preparing' with no error — mark it failed and release the claim.
  const spawn = opts.spawn ?? defaultSpawn;
  let pid: number | null = null;
  try {
    pid = await spawn(runId, outcome.scope);
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

// ── pending-run pump ───────────────────────────────────────────────────────
// A periodic tick that (1) reaps stale leases — OOM-killed workers whose runs
// would otherwise sit wedged in 'running' until the next server restart, since
// reconcileOrphanedRuns only runs at boot — and (2) re-dispatches runs the
// admission gate deferred to 'pending', oldest first, until the host is full.
const DEFAULT_PUMP_MS = 15_000;
const DEFAULT_MAX_DEFER_MS = 30 * 60_000;
const PUMP_KEY = "__taskOrchPendingPump";

function pumpIntervalMs(): number {
  return intEnv("TASK_ORCH_PENDING_PUMP_MS", DEFAULT_PUMP_MS);
}

async function pumpTick(): Promise<void> {
  // Half 1: reap stale leases continuously (fixes the boot-only reconcile gap).
  try {
    await runs().reconcileOrphanedRuns();
  } catch {
    // best-effort
  }
  // Half 2: drain the deferred queue, oldest first. Stop at the first defer (the
  // host is full); the next tick retries.
  let ids: number[];
  try {
    ids = await runs().listPendingRunIds();
  } catch {
    return;
  }
  const maxDeferMs = intEnv("TASK_ORCH_MAX_DEFER_MS", DEFAULT_MAX_DEFER_MS);
  const now = Date.now();
  for (const id of ids) {
    const run = await runs().get(id);
    if (!run || run.status !== "pending") continue;
    // Time in THIS pending episode: heartbeatAt is stamped when a run is deferred
    // into pending (dispatchRun's defer branch); a run born pending has no stamp
    // and is measured from startedAt (≈ its enqueue time).
    const pendingSince = run.heartbeatAt ?? run.startedAt;
    if (maxDeferMs > 0 && pendingSince && now - pendingSince.getTime() > maxDeferMs) {
      await runs().failRun(
        id,
        "insufficient host memory: the run stayed queued past the maximum wait (TASK_ORCH_MAX_DEFER_MS)."
      );
      continue;
    }
    const r = await dispatchRun(id);
    if (r === "deferred") break;
  }
}

/** Start the periodic pump (idempotent). No-op off the containerized path or when
 *  the interval is disabled (TASK_ORCH_PENDING_PUMP_MS=0). */
export function startPendingRunPump(): void {
  if (!process.env.TASK_ORCH_WORKER_IMAGE) return;
  const ms = pumpIntervalMs();
  if (ms <= 0) return;
  const g = globalThis as Record<string, unknown>;
  if (g[PUMP_KEY]) return;
  const timer = setInterval(() => void pumpTick().catch(() => {}), ms);
  (timer as { unref?: () => void }).unref?.();
  g[PUMP_KEY] = timer;
}

/** Stop the pump (tests / graceful shutdown). */
export function stopPendingRunPump(): void {
  const g = globalThis as Record<string, unknown>;
  const t = g[PUMP_KEY];
  if (t) {
    clearInterval(t as ReturnType<typeof setInterval>);
    delete g[PUMP_KEY];
  }
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
  if (claudeHome) {
    // The worker runs as the non-root `node` user (HOME=/home/node) because the
    // Claude Code CLI refuses --dangerously-skip-permissions as root. Mount the
    // host session store into node's HOME.
    binds.push(`${claudeHome}:/home/node/.claude`);
    // Claude Code also reads its main config from $HOME/.claude.json (a sibling
    // of the .claude/ dir, not inside it). Without it the SDK's `query()` claude
    // process exits 1. Mount it alongside.
    binds.push(`${claudeHome}.json:/home/node/.claude.json`);
  }
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
      // Hard per-worker cgroup caps (Memory/MemorySwap/NanoCpus/PidsLimit) so a
      // single runaway worker can't take the host down. Opt-in via env; {} when
      // unset. Paired with the admission gate in dispatchRun, which bounds the
      // AGGREGATE across concurrent workers.
      ...buildWorkerLimits(),
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
