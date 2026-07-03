// lib/run-dispatch.ts
import { and, eq, isNull } from "drizzle-orm";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import type { RunRow } from "./runs";
import { isTerminalStatus } from "./types";

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
  /** Runs in a lease status with a worker claim (the sweep's run-side view). */
  listLeasedRuns: () => Promise<RunRow[]>;
  /** Apply the worker-death policy to a run whose container is known dead. */
  handleWorkerDeath: (
    runId: number,
    info: { exitCode: number | null; oomKilled: boolean; containerName: string }
  ) => Promise<void>;
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
    // Atomic claim: only succeeds if worker_scope is still NULL. Also clear any
    // captured worker log/exit code from a PRIOR container so the run view never
    // pairs this fresh attempt's live container with a dead one's "exit 137".
    const claimed = await db
      .update(agentSessions)
      .set({
        status: "preparing",
        workerScope: scope,
        cancelRequested: 0,
        heartbeatAt: new Date(),
        workerLog: null,
        workerExitCode: null,
      })
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
  // Half 0: reconcile against the REAL container state — fast death detection +
  // log capture for anything the events watcher missed.
  try {
    await sweepWorkerContainers();
  } catch {
    // best-effort
  }
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
// container name; the worker monitor below tracks the container's REAL state;
// cancel() calls stopWorkerContainer.

/** Full createContainer options for a run's worker (exported for tests). */
export function buildWorkerContainerConfig(runId: number, scope: string): Record<string, unknown> {
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
    // Idle timeout for the long-lived chat-session loop (driveChatSession reads it
    // in the worker). Empty => the worker's built-in default.
    pass("TASK_ORCH_CHAT_IDLE_MS"),
    "TASK_ORCH_DETACHED_RUNS=1",
    // Signals the in-container checkout strategy (Phase 5): clone from the
    // mounted repo-cache mirror instead of a host worktree.
    "REPO_CACHE_DIR=/repo-cache",
    // "I am the worker" marker: the server-side message path (sendMessageToRun)
    // dispatches turns to a worker, but the worker itself must run them in-process
    // (never re-dispatch). Any code branching on "am I the worker" reads this.
    "TASK_ORCH_INSIDE_WORKER=1",
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

  return {
    Image: image,
    name: scope,
    Cmd: [String(runId)],
    Env: env,
    // The worker monitor maps containers back to runs by RUN_LABEL, and scopes
    // to THIS instance by INSTANCE_LABEL (so a co-hosted stack's workers are
    // never touched — see the label docs above).
    Labels: { [RUN_LABEL]: String(runId), [INSTANCE_LABEL]: instanceId() },
    HostConfig: {
      // Deliberately NO AutoRemove: when the container dies, the monitor first
      // captures `docker logs` + the exit code into the run row, THEN removes
      // the container. AutoRemove would race that capture and lose the logs of
      // exactly the crashes we most need to debug (OOM kill, boot failure).
      Binds: binds,
      // Bound the on-disk json log so a chatty worker can't fill the host disk.
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
      // Hard per-worker cgroup caps (Memory/MemorySwap/NanoCpus/PidsLimit) so a
      // single runaway worker can't take the host down. Opt-in via env; {} when
      // unset. Paired with the admission gate in dispatchRun, which bounds the
      // AGGREGATE across concurrent workers.
      ...buildWorkerLimits(),
      ...(process.env.TASK_ORCH_DOCKER_NETWORK
        ? { NetworkMode: process.env.TASK_ORCH_DOCKER_NETWORK }
        : {}),
    },
  };
}

async function dockerSpawn(runId: number, scope: string): Promise<number | null> {
  const docker = await getDocker();
  const container = await docker.createContainer(buildWorkerContainerConfig(runId, scope));
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
    env: { ...process.env, TASK_ORCH_INSIDE_WORKER: "1" },
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
    const docker = await getDocker();
    await docker.getContainer(scope).stop({ t: 5 });
  } catch {
    // already stopped / removed / unreachable — nothing to do
  }
}

// ── worker container monitor ─────────────────────────────────────────────────
// Keep the DB's picture of a run as close as possible to the REAL container
// state, instead of trusting only the worker's self-reported heartbeat (a killed
// worker reports nothing and used to sit "running" until the 5-minute timeout).
// Two complementary mechanisms:
//   - startWorkerMonitor(): a Docker events subscription that reacts the moment
//     a worker container dies — captures its logs + exit code, then applies the
//     death policy (lib/runs.handleWorkerDeath). Seconds, not minutes.
//   - sweepWorkerContainers(): a per-pump-tick reconcile that repairs whatever
//     the events stream missed (server restart, dropped subscription): cleans up
//     exited containers, stops strays whose run already finished, and declares
//     dead any leased run whose container no longer exists at all.

/** Container label carrying the run id; how the monitor maps containers→runs. */
export const RUN_LABEL = "task-orch.run";
/** Container label scoping a worker to ONE orchestrator instance. Without it, a
 *  second stack sharing the host Docker socket (staging beside prod, a dev server
 *  pointed at the host socket) would see the other's workers as strays and stop
 *  them / delete their exited containers — each instance judges containers
 *  against its OWN database. Every list/events query filters on this so an
 *  instance only ever touches containers it launched. */
export const INSTANCE_LABEL = "task-orch.instance";
/** This instance's id. Prefer an explicit override; else the compose network
 *  (project-scoped, distinct per stack); else a shared default (single-stack
 *  hosts, today's behavior). */
export function instanceId(): string {
  return (
    process.env.TASK_ORCH_INSTANCE_ID ||
    process.env.TASK_ORCH_DOCKER_NETWORK ||
    "default"
  );
}
/** Label filter (dockerode `filters.label`) scoping to this instance's workers. */
function instanceLabelFilter(): string[] {
  return [RUN_LABEL, `${INSTANCE_LABEL}=${instanceId()}`];
}
/** Stored log tail cap (chars) so the run row stays bounded. */
const WORKER_LOG_MAX_CHARS = 64 * 1024;
const EVENTS_RECONNECT_MS = 5_000;
// A freshly claimed run has no container while dockerSpawn's create round-trip
// is in flight, and the sweep's container list is a point-in-time snapshot;
// require this much heartbeat silence before declaring a leased run dead.
const SWEEP_MIN_SILENCE_MS = 30_000;
// Don't stop a still-running container the instant its run lands terminal — the
// worker may still be flushing final writes / cleanup after setting the status.
const STRAY_STOP_GRACE_MS = 60_000;

// Minimal dockerode surface the monitor touches (tests inject a fake).
export type DockerLike = {
  createContainer(opts: unknown): Promise<{ start(): Promise<unknown> }>;
  listContainers(opts: unknown): Promise<
    Array<{ Id: string; Names?: string[]; State?: string; Labels?: Record<string, string> }>
  >;
  getContainer(ref: string): {
    logs(opts: unknown): Promise<Buffer | NodeJS.ReadableStream>;
    inspect(): Promise<{ State?: { ExitCode?: number; OOMKilled?: boolean } }>;
    remove(opts?: unknown): Promise<unknown>;
    stop(opts?: unknown): Promise<unknown>;
  };
  getEvents(opts: unknown): Promise<NodeJS.ReadableStream>;
};

async function getDocker(): Promise<DockerLike> {
  const { default: Docker } = await import("dockerode");
  return new Docker() as unknown as DockerLike;
}

/**
 * Docker multiplexes stdout/stderr into 8-byte-header frames when the container
 * has no TTY: [stream(1), 0,0,0, len(4, BE)] + payload. Workers run TTY-less, so
 * `docker logs` buffers arrive in this format; strip the headers. A buffer that
 * doesn't look multiplexed (TTY container / plain text) passes through verbatim.
 */
export function demuxDockerLog(buf: Buffer): string {
  if (buf.length === 0) return "";
  const looksMultiplexed =
    buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMultiplexed) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    const start = off + 8;
    parts.push(buf.subarray(start, Math.min(start + len, buf.length)));
    off = start + len;
  }
  return Buffer.concat(parts).toString("utf8");
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

/** Tail of a container's stdout+stderr, demuxed; null if unreadable/gone. */
export async function fetchContainerLog(
  ref: string,
  docker?: DockerLike
): Promise<string | null> {
  try {
    const d = docker ?? (await getDocker());
    const out = await d
      .getContainer(ref)
      .logs({ stdout: true, stderr: true, tail: 2000, follow: false });
    const buf = Buffer.isBuffer(out) ? out : await readAll(out);
    const text = demuxDockerLog(buf);
    if (text.length <= WORKER_LOG_MAX_CHARS) return text;
    let tail = text.slice(-WORKER_LOG_MAX_CHARS);
    // The cut can land mid-surrogate-pair (an emoji in the log); a leading lone
    // low surrogate is invalid UTF-8 and Postgres would reject the insert.
    const first = tail.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
    return tail;
  } catch {
    return null;
  }
}

/**
 * A worker container is done (die event, or found exited by the sweep): persist
 * its final log + exit code onto the run, remove the container, then apply the
 * death policy — but only if this container still OWNS the run. A stale
 * container from a superseded claim gets removed without touching the run.
 */
export async function handleContainerExit(
  info: { runId: number; containerName: string; exitCode: number | null; oomKilled: boolean },
  docker?: DockerLike
): Promise<void> {
  const d = docker ?? (await getDocker());
  const run = await runs().get(info.runId);
  const isCurrent = !!run && run.workerScope === info.containerName;
  if (isCurrent) {
    const log = await fetchContainerLog(info.containerName, d);
    const patch: Record<string, unknown> = {};
    if (log) patch.workerLog = log;
    if (info.exitCode != null) patch.workerExitCode = info.exitCode;
    if (Object.keys(patch).length > 0) {
      // Condition the write on the scope STILL matching: fetchContainerLog can
      // stall, and a re-dispatch in that window would repoint worker_scope at a
      // new container — this must not overwrite the new attempt's log/exit code
      // with this dead one's.
      await db
        .update(agentSessions)
        .set(patch)
        .where(
          and(eq(agentSessions.id, info.runId), eq(agentSessions.workerScope, info.containerName))
        );
    }
  }
  try {
    await d.getContainer(info.containerName).remove({ force: true });
  } catch {
    // already removed (event/sweep race) — fine
  }
  if (isCurrent) {
    await runs().handleWorkerDeath(info.runId, {
      exitCode: info.exitCode,
      oomKilled: info.oomKilled,
      containerName: info.containerName,
    });
  }
}

type DockerEvent = {
  Action?: string;
  status?: string;
  id?: string;
  Actor?: { Attributes?: Record<string, string> };
};

// Containers hitting the kernel OOM killer emit an `oom` event shortly before
// `die`; remember them briefly so the die handler can say WHY the worker died.
const oomFlags = new Map<string, number>();
function markOom(containerId: string): void {
  oomFlags.set(containerId, Date.now());
  if (oomFlags.size > 200) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, t] of oomFlags) if (t < cutoff) oomFlags.delete(k);
  }
}

/** React to one Docker container event (exported for tests). */
export async function handleWorkerEvent(evt: DockerEvent, docker?: DockerLike): Promise<void> {
  const action = evt.Action ?? evt.status;
  const attrs = evt.Actor?.Attributes ?? {};
  const runId = Number(attrs[RUN_LABEL]);
  if (!Number.isFinite(runId)) return;
  if (action === "oom") {
    if (evt.id) markOom(evt.id);
    return;
  }
  if (action !== "die") return;
  const rawExit = Number(attrs.exitCode);
  const exitCode = Number.isFinite(rawExit) ? rawExit : null;
  const oomKilled = (evt.id ? oomFlags.delete(evt.id) : false) || exitCode === 137;
  await handleContainerExit(
    { runId, containerName: attrs.name ?? "", exitCode, oomKilled },
    docker
  );
}

const MONITOR_KEY = "__taskOrchWorkerMonitor";
type MonitorState = { stopped: boolean; stream: { destroy?: () => void } | null };

/** Subscribe to Docker container events for worker containers (idempotent;
 *  no-op off the containerized path). Reconnects itself if the stream drops —
 *  and whatever slips through a gap is repaired by sweepWorkerContainers. */
export function startWorkerMonitor(): void {
  if (!process.env.TASK_ORCH_WORKER_IMAGE) return;
  const g = globalThis as Record<string, unknown>;
  if (g[MONITOR_KEY]) return;
  const state: MonitorState = { stopped: false, stream: null };
  g[MONITOR_KEY] = state;
  void connectWorkerEvents(state);
}

/** Stop the events subscription (tests / graceful shutdown). */
export function stopWorkerMonitor(): void {
  const g = globalThis as Record<string, unknown>;
  const state = g[MONITOR_KEY] as MonitorState | undefined;
  if (!state) return;
  state.stopped = true;
  state.stream?.destroy?.();
  delete g[MONITOR_KEY];
}

async function connectWorkerEvents(state: MonitorState): Promise<void> {
  if (state.stopped) return;
  let scheduled = false;
  const reconnect = () => {
    if (scheduled || state.stopped) return; // 'error' and 'end' both fire
    scheduled = true;
    state.stream = null;
    const t = setTimeout(() => void connectWorkerEvents(state), EVENTS_RECONNECT_MS);
    (t as { unref?: () => void }).unref?.();
  };
  try {
    const docker = await getDocker();
    const stream = await docker.getEvents({
      filters: { type: ["container"], event: ["die", "oom"], label: instanceLabelFilter() },
    });
    state.stream = stream as unknown as MonitorState["stream"];
    // The events endpoint emits newline-delimited JSON; chunks can split a line.
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          void handleWorkerEvent(JSON.parse(line) as DockerEvent).catch(() => {});
        } catch {
          // malformed frame — skip
        }
      }
    });
    stream.on("error", reconnect);
    stream.on("end", reconnect);
    stream.on("close", reconnect);
  } catch {
    reconnect();
  }
}

/**
 * Reconcile DB run state against the real container state, both directions.
 * Runs every pump tick. Covers everything the events stream can miss: deaths
 * while the server was down, dropped subscriptions, containers left behind by
 * older deploys.
 */
export async function sweepWorkerContainers(dockerArg?: DockerLike): Promise<void> {
  if (!dockerArg && !process.env.TASK_ORCH_WORKER_IMAGE) return;
  let docker: DockerLike;
  let containers: Awaited<ReturnType<DockerLike["listContainers"]>>;
  try {
    docker = dockerArg ?? (await getDocker());
    containers = await docker.listContainers({
      all: true,
      filters: { label: instanceLabelFilter() },
    });
  } catch {
    return; // docker unreachable — nothing to reconcile against
  }
  const liveNames = new Set<string>();
  for (const c of containers) {
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    if (name) liveNames.add(name);
  }

  const now = Date.now();
  for (const c of containers) {
    const runId = Number(c.Labels?.[RUN_LABEL]);
    const name = (c.Names?.[0] ?? "").replace(/^\//, "");
    if (!Number.isFinite(runId) || !name) continue;
    if (c.State === "exited" || c.State === "dead") {
      // Normally the events watcher got here first; this is the catch-up path.
      let exitCode: number | null = null;
      let oom = false;
      try {
        const ins = await docker.getContainer(c.Id).inspect();
        exitCode = ins.State?.ExitCode ?? null;
        oom = !!ins.State?.OOMKilled;
      } catch {
        // vanished between list and inspect
      }
      await handleContainerExit(
        { runId, containerName: name, exitCode, oomKilled: oom || exitCode === 137 },
        docker
      );
      liveNames.delete(name);
    } else if (c.State === "running") {
      // Stray check: a live container whose run is finished, or that lost its
      // claim to a newer container, burns memory for nothing — stop it. The die
      // event / next sweep then captures logs and removes it.
      const run = await runs().get(runId);
      const stray =
        !run ||
        run.workerScope !== name ||
        (isTerminalStatus(run.status) &&
          (run.completedAt == null || now - run.completedAt.getTime() > STRAY_STOP_GRACE_MS));
      if (stray) {
        try {
          await docker.getContainer(name).stop({ t: 5 });
        } catch {
          // already stopping/gone
        }
      }
    }
  }

  // Reverse direction: runs holding a worker claim whose container doesn't exist
  // at all (died and was removed while nothing was watching). Declare them dead
  // now instead of waiting out the 5-minute heartbeat timeout. The silence guard
  // avoids racing a dispatch whose container is still being created.
  let leased: RunRow[];
  try {
    leased = await runs().listLeasedRuns();
  } catch {
    return;
  }
  for (const run of leased) {
    if (!run.workerScope || liveNames.has(run.workerScope)) continue;
    const lastSeen = run.heartbeatAt?.getTime() ?? 0;
    if (now - lastSeen < SWEEP_MIN_SILENCE_MS) continue;
    await runs().handleWorkerDeath(run.id, {
      exitCode: null,
      oomKilled: false,
      containerName: run.workerScope,
    });
  }
}
