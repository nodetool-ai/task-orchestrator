// lib/run-dispatch.ts
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { AGENT_CREDENTIAL_ENV_KEYS } from "./agent-backend/provider-env";
// lib/inbox has no static import of this module (its wake path uses a lazy
// dynamic import), so this edge is cycle-free.
import { fireDueTimers, parkedRunsWithPendingEvents } from "./inbox";
import type { RunRow } from "./runs";
import {
  config,
  detachedRunsEnabled as detachedRunsEnabledCfg,
  intEnv,
  floatEnv,
  lightweightIsolation,
  runnerProviderKind,
} from "./config";
import { isWorkerLive } from "./run-liveness";
import { runNonce } from "./run-nonce";
import { HARD_TERMINAL_STATUSES } from "./run-state";
import {
  getRunnerProvider,
  runnerProviderKindFromEnv,
  insideWorker,
  nestedDispatchMode,
  type RunnerAdmission,
  type RunnerAdmissionInput,
} from "./runner/provider";
import { recordDispatch, recordRunnerEvent, timeRunnerPhase } from "./runner/telemetry";
import { isTerminalStatus } from "./types";
import { workerDispatchEnv } from "./worker/token";

// Spawns the worker for a run and returns a truthy "pid" on success or null on
// failure. May be async (the Docker API is): dispatchRun awaits it.
export type SpawnFn = (runId: number, scope: string) => number | null | Promise<number | null>;

/** Admission decision for a run about to be dispatched. */
export type AdmitDecision = "admit" | "defer" | "never-fits";
/** Injectable admission check (tests override it; defaults to `admit`). */
export type AdmitFn = (runId: number) => AdmitDecision | Promise<AdmitDecision>;
/** Injectable provider admission (used by Box capacity tests). */
export type ProviderAdmitFn = (input: RunnerAdmissionInput) => RunnerAdmission | Promise<RunnerAdmission>;

export type DispatchResult =
  | "spawned"
  | "already-claimed"
  | "not-found"
  | "spawn-failed"
  | "deferred"
  // R2: the run's persisted placement is 'server' — dispatchRun handed it to the
  // in-process server resume path and provisioned NO worker.
  | "server-resumed";

// Late-bound bridge back into lib/runs (avoids a static import cycle; runs.ts
// injects these on load). See the longer note kept from the systemd era.
type RunsApi = {
  get: (id: number) => Promise<RunRow | null>;
  isLeaseLive: (run: { status: string; heartbeatAt: Date | null }, now?: number) => boolean;
  /** Mark a run failed with an error (updates status + emits a status event). */
  failRun: (runId: number, error: string) => Promise<void>;
  /** Atomically fail a run still 'pending' with no worker claim (status + event
   *  in one tx, guarded). Returns true iff it actually failed the row. */
  failPendingRun: (runId: number, error: string) => Promise<boolean>;
  /** Count runs holding a worker slot (worker_scope set + a lease status). */
  countInFlightWorkers: () => Promise<number>;
  /** Count live lightweight children (runtime='server' + claim + fresh beat).
   *  Bounds the lightweight tier's fork concurrency (TASK_ORCH_LIGHTWEIGHT_MAX_CHILDREN). */
  countInFlightLightweightChildren: () => Promise<number>;
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
  /** Re-verify the run-tree depth/size caps (docs/nested-machine-dispatch.md,
   *  Decision 2) for a run that already has a parentRunId. Returns an error
   *  message naming the violated limit, or null if the run is fine (including
   *  root runs, which have no tree to bound). Defense in depth: create()
   *  already checks this before insert, but a worker writing rows directly
   *  would bypass that. */
  checkTreeLimits: (runId: number) => Promise<string | null>;
  /** Drive one in-process turn for a 'server'-placement run (R2): claim →
   *  bounded turn → release. dispatchRun routes here instead of provisioning a
   *  worker when the run's runtime column is 'server'. */
  resumeServerRun: (runId: number) => Promise<void>;
};
let runsApi: RunsApi | null = null;
export function __setRunsApi(api: RunsApi): void {
  runsApi = api;
}
function runs(): RunsApi {
  if (!runsApi) throw new Error("run-dispatch: runs API not initialized");
  return runsApi;
}

// Nested-dispatch policy helpers (docs/nested-machine-dispatch.md, Decision 5)
// live in ./runner/provider — NOT here — because lib/runner/fly.ts also needs
// nestedDispatchMode (for buildFlyWorkerEnv), and a static value import
// fly.ts → run-dispatch would close a cycle (run-dispatch → provider → fly →
// run-dispatch). provider.ts is the shared low-level module both can import.
// Re-exported here so callers reasoning about dispatch policy find them next to
// detachedRunsEnabled(); runs.ts's launch branches import them from this module.
export { insideWorker, nestedDispatchMode };
export type { NestedDispatchMode } from "./runner/provider";

export function detachedRunsEnabled(): boolean {
  return detachedRunsEnabledCfg();
}

/** True when the server must route user turns through an out-of-process runner.
 *  Also true INSIDE an isolate-mode worker: there, turns are remote by policy —
 *  the worker holds no Fly credentials, so append paths must defer to the
 *  server (see runs.sendMessageToRun) rather than drive a child in-process.
 *  Workers never receive TASK_ORCH_RUNNER / TASK_ORCH_WORKER_IMAGE (see
 *  lib/runner/provider.ts:77), so the env-based check alone is always false
 *  in exactly the environment that most needs the remote path. */
export function remoteRunnerEnabled(): boolean {
  if (insideWorker() && nestedDispatchMode() === "isolate") return true;
  return detachedRunsEnabled() && (runnerProviderKind() !== "local" || !!config.deployment.workerImage);
}

// ── env helpers ────────────────────────────────────────────────────────────
// intEnv / floatEnv now live in lib/config (single parsing convention).

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

// A lightweight child is a Node process, not a container: its V8 heap is capped
// by --max-old-space-size (TASK_ORCH_LIGHTWEIGHT_MEMORY_MB) but it also uses
// non-heap memory (C++/V8 metadata, buffers, the pi SDK's native bits). Reserve a
// fixed allowance on top of the heap cap so the host budget accounting reflects a
// child's REAL footprint, not just its JS heap. 128MB is a deliberately generous
// round number (a typical idle Node RSS overhead is well under this).
export const LIGHTWEIGHT_NONHEAP_OVERHEAD_MB = 128;

/** Per-child host reservation: heap cap + non-heap overhead. 0 when the heap cap
 *  is disabled (TASK_ORCH_LIGHTWEIGHT_MEMORY_MB=0 ⇒ unbounded ⇒ no memory gate,
 *  only the count cap applies). */
export function lightweightChildReserveMB(): number {
  const heap = config.features.lightweightMemoryMb;
  return heap > 0 ? heap + LIGHTWEIGHT_NONHEAP_OVERHEAD_MB : 0;
}

/**
 * Pure admission decision for a lightweight child. Draws on the SAME host budget
 * (memTotalMB − reserveMB) as the worker gate, charged with BOTH in-flight
 * workers (each at its full cap) AND in-flight children (each at childReserveMB),
 * so the two tiers can't jointly oversubscribe the host. Effective concurrency is
 * therefore min(maxChildren, what still fits in the budget). A single child whose
 * reservation exceeds the whole budget can never fit → never-fits (fatal misconfig).
 */
export function lightweightAdmissionDecision(i: {
  childReserveMB: number;
  workerCapMB: number;
  reserveMB: number;
  maxChildren: number;
  inFlightChildren: number;
  inFlightWorkers: number;
  memTotalMB: number;
  memAvailableMB: number | null;
}): AdmitDecision {
  if (i.maxChildren > 0 && i.inFlightChildren >= i.maxChildren) return "defer";
  if (i.childReserveMB > 0) {
    const budget = i.memTotalMB - i.reserveMB;
    if (i.childReserveMB > budget) return "never-fits";
    const used = i.inFlightWorkers * i.workerCapMB + i.inFlightChildren * i.childReserveMB;
    if (budget - used < i.childReserveMB) return "defer";
    if (i.memAvailableMB != null && i.memAvailableMB - i.reserveMB < i.childReserveMB) return "defer";
  }
  return "admit";
}

// hasLiveWorkerClaim was a third copy of the worker-liveness predicate; it now
// lives in lib/run-liveness as isWorkerLive (R8). The stale window is that
// module's single HEARTBEAT_STALE_MS.

/** The gate only runs for managed worker backends, and can be turned off. */
function admissionEnabled(): boolean {
  // Box admission always probes account limits before a fork/resume. Unlike the
  // legacy host gate, disabling TASK_ORCH_ADMISSION_ENABLED must not allow a
  // deployment to exceed the remote account's capacity.
  if (runnerProviderKind() === "box") return true;
  if (!config.dispatch.admissionFlag) return false;
  if (runnerProviderKind() === "fly") return config.dispatch.maxMachines > 0;
  return !!config.deployment.workerImage;
}

const FLY_ADMISSION_STATES = ["creating", "starting", "running"];

async function flyAdmit(): Promise<AdmitDecision> {
  const maxMachines = intEnv("TASK_ORCH_MAX_MACHINES", 0);
  if (maxMachines <= 0) return "admit";
  const active = await db
    .select({ runId: runnerInstances.runId })
    .from(runnerInstances)
    .where(and(eq(runnerInstances.provider, "fly"), inArray(runnerInstances.state, FLY_ADMISSION_STATES)));
  return active.length >= maxMachines ? "defer" : "admit";
}

async function admit(runId: number): Promise<AdmitDecision> {
  void runId; // reserved for future per-run sizing; decision is host-global today
  if (runnerProviderKindFromEnv() === "fly") return flyAdmit();
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

async function providerAdmit(input: RunnerAdmissionInput): Promise<RunnerAdmission> {
  const provider = getRunnerProvider();
  if (provider.admit) return provider.admit(input);
  return { decision: await admit(input.runId) };
}

/** The lightweight-child gate runs whenever the child has a memory reservation
 *  (heap cap set — the default) or a concurrency cap. Both are on by default, so
 *  lightweight children are always bounded unless BOTH knobs are explicitly 0. */
function lightweightGateActive(): boolean {
  return lightweightChildReserveMB() > 0 || config.features.lightweightMaxChildren > 0;
}

/** Memory-aware admission for a lightweight child: reserve its heap cap + non-heap
 *  overhead against the shared host budget already charged with live workers AND
 *  other live children, then enforce the child count cap. Uses the same host-memory
 *  detection as the worker gate (readHostMemory) — one source of truth. */
async function lightweightAdmit(runId: number): Promise<AdmitDecision> {
  void runId; // decision is host-global today (per-run sizing reserved for later)
  const inFlightChildren = await runs().countInFlightLightweightChildren();
  const inFlightWorkers = await runs().countInFlightWorkers();
  const host = await readHostMemory();
  return lightweightAdmissionDecision({
    childReserveMB: lightweightChildReserveMB(),
    workerCapMB: intEnv("TASK_ORCH_WORKER_MEMORY_MB", 0),
    reserveMB: intEnv("TASK_ORCH_HOST_MEMORY_RESERVE_MB", 0),
    maxChildren: config.features.lightweightMaxChildren,
    inFlightChildren,
    inFlightWorkers,
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
  opts: { spawn?: SpawnFn; admit?: AdmitFn; providerAdmit?: ProviderAdmitFn } = {}
): Promise<DispatchResult> {
  const provider = runnerProviderKindFromEnv();
  const dispatchStarted = process.hrtime.bigint();
  const finish = (result: DispatchResult): DispatchResult => {
    recordDispatch(result, {
      provider,
      runId,
      fields: { durationMs: Number(process.hrtime.bigint() - dispatchStarted) / 1_000_000 },
    });
    return result;
  };

  // Placement routing (R2): dispatchRun is the single front door. A run whose
  // persisted placement is 'server' takes the lightweight tier (the loop needs DB
  // access a credential-less HTTP worker doesn't have). This is the fix for the
  // run-131 incident: the emit-time inbox wakes (lib/inbox) and the pump's
  // parked-wake sweep both call dispatchRun, so they inherit this routing for free
  // — no per-caller placement logic. Two isolation modes decide WHERE the turn
  // runs (see the lightweightChild note below): the default 'child' claims + spawns
  // a memory-capped local Node child through the machinery below (env inherited,
  // db transport), while 'inprocess' hands the run to the in-process server resume
  // path — which takes its own server-turn claim (duplicate wakes short-circuit
  // there) and drives the turn in the background so a caller awaiting dispatchRun
  // (the pump loop) isn't blocked for the whole turn. In the 'inprocess' branch a
  // test-injected `opts.spawn` is deliberately ignored: it never spawns a provider.
  const placementRun = await runs().get(runId);
  if (!placementRun) return finish("not-found");
  // Lightweight isolation (default 'child'): a 'server'-placement run's turns run
  // in a memory-capped local Node child (spawnLightweightChild), reusing the
  // worker claim + detached-spawn machinery below — the child inherits env
  // (DATABASE_URL retained → db transport) and heartbeats like any worker, so the
  // reaper/pump/death machinery keeps working. 'inprocess' preserves the original
  // behavior: turns run IN the web-server process via the server-resume path.
  const lightweightChild = placementRun.runtime === "server" && lightweightIsolation() === "child";
  if (placementRun.runtime === "server" && !lightweightChild) {
    void runs().resumeServerRun(runId).catch((err) => {
      console.error(`Server resume failed for run ${runId}:`, err);
    });
    return finish("server-resumed");
  }

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

    // Tree-limit re-verify (Decision 2 in docs/nested-machine-dispatch.md):
    // create() already rejects an over-depth/over-size child before insert, but
    // that's a courtesy for the common path — a worker could write a child row
    // directly (or repoint parent_run_id) and skip it entirely. Re-check here,
    // before the claim, so no row this deep/large ever gets a real worker
    // (container/Machine). Unlike admission's "defer, retry later" policy, a
    // tree-limit violation is a permanent rejection: retrying won't shrink the
    // tree, so fail the run now instead of parking it in 'pending' forever.
    if (run.parentRunId != null) {
      const violation = await runs().checkTreeLimits(runId);
      if (violation) {
        await runs().failRun(runId, violation);
        return { kind: "spawn-failed" };
      }
    }

    // Admission gate. Two flavors that draw on the SAME host memory budget so
    // heavy workers and lightweight children can't jointly oversubscribe the host:
    //  - worker runs: the provider-gated memory/machine gate (admit()), active
    //    only for a managed backend (Docker image / Fly).
    //  - lightweight children: lightweightAdmit(), which reserves this child's
    //    heap cap + a fixed non-heap overhead against (host − reserve) MINUS what
    //    both in-flight workers AND other in-flight children already hold, and
    //    also enforces the TASK_ORCH_LIGHTWEIGHT_MAX_CHILDREN count. Active
    //    whenever the child has a memory reserve or a count cap (i.e. by default).
    const gateActive = lightweightChild ? lightweightGateActive() : admissionEnabled();
    if (gateActive) {
      let decision: AdmitDecision;
      if (opts.admit) {
        decision = await opts.admit(runId);
      } else if (lightweightChild) {
        decision = await lightweightAdmit(runId);
      } else {
        const reservedActive = await runs().countInFlightWorkers();
        const providerDecision = await (opts.providerAdmit ?? providerAdmit)({ runId, reservedActive });
        if (providerDecision.decision === "reject") {
          await runs().failRun(runId, providerDecision.message);
          return { kind: "spawn-failed" };
        }
        decision = providerDecision.decision;
      }
      // Deadlock breaker (M1): a plan-executor run occupies a worker slot for
      // its ENTIRE turn (countInFlightWorkers/flyAdmit count it the whole
      // time), and blocks in await_session waiting on the very children it
      // just spawned. If every slot is held by executors, admission defers
      // every child to 'pending' forever — the executors never finish (so
      // never free a slot), the pump's retries never help, and eventually
      // TASK_ORCH_MAX_DEFER_MS hard-fails the children as "insufficient host
      // memory": a livelock with money spent and nothing done. No component
      // otherwise models the parent→child dependency. Break the cycle: a
      // child whose parent still holds a live worker claim is admitted even
      // over the cap — the parent's slot is blocked awaiting this very child,
      // so deferring it only deadlocks the tree. This applies to BOTH the
      // memory-based gate and flyAdmit's machine-count gate (whichever
      // admitFn returned "defer"), and to the lightweight child gate; it does
      // NOT apply to "never-fits" (a single reservation exceeding the whole
      // host budget is a fatal misconfig no parent claim can fix). The overshoot
      // this permits is bounded by the run tree's own depth/spawn caps.
      if (decision === "defer" && run.parentRunId != null) {
        const parent = await runs().get(run.parentRunId);
        if (parent && isWorkerLive(parent)) decision = "admit";
      }
      if (decision === "never-fits") {
        await runs().failRun(
          runId,
          lightweightChild
            ? "insufficient host memory: a single lightweight child's memory reservation (TASK_ORCH_LIGHTWEIGHT_MEMORY_MB + non-heap overhead) exceeds the host budget (raise the host, lower TASK_ORCH_LIGHTWEIGHT_MEMORY_MB, or lower TASK_ORCH_HOST_MEMORY_RESERVE_MB)."
            : "insufficient host memory: a single worker's memory cap exceeds the host budget (raise the host, lower TASK_ORCH_WORKER_MEMORY_MB, or lower TASK_ORCH_HOST_MEMORY_RESERVE_MB)."
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

    const scope = `run-${runId}-${runNonce()}`;
    // Atomic claim: only succeeds if worker_scope is still NULL AND the status is
    // still claimable. 'cancelled'/'closed' are terminal decisions that must NEVER
    // be resurrected — a claim landing on them would flip the row to 'preparing'
    // and wipe cancelRequested, silently undoing a cancel that raced this dispatch
    // (runs.cancel() no-ops stopRunner when no container exists yet). Every other
    // status IS claimable here: 'pending'/'idle'/'parked' (a parked run woken by
    // an inbox event resumes exactly like an idle run), the lease statuses (only reached
    // once isLeaseLive is false — an orphan whose stale claim was cleared), and the
    // resumable terminal statuses (completed/failed/budget_exhausted) for follow-up
    // turns. scope is the claim's ownership token. Also clear every PRIOR
    // attempt's terminal artifact so the freshly-claimed run never displays a
    // dead attempt's state: the worker log/exit code (so the run view can't pair
    // this live container with a dead one's "exit 137"), AND the error/
    // completed_at (so a revived run reads as running, not as its last failure —
    // run 58 was actively running while still showing "Interrupted by a process
    // restart" and a completed_at hours in the past).
    const claimed = await db
      .update(agentSessions)
      .set({
        status: "preparing",
        workerScope: scope,
        cancelRequested: 0,
        heartbeatAt: new Date(),
        workerLog: null,
        workerExitCode: null,
        error: null,
        completedAt: null,
      })
      .where(
        and(
          eq(agentSessions.id, runId),
          isNull(agentSessions.workerScope),
          notInArray(agentSessions.status, HARD_TERMINAL_STATUSES)
        )
      );
    if (claimed.count === 0) return { kind: "already-claimed" };
    return { kind: "claimed", scope };
  });

  if (outcome.kind !== "claimed") return finish(outcome.kind);
  recordRunnerEvent("runner_claimed", { provider, runId, fields: { scope: outcome.scope } });

  // Start the worker through the selected provider. A throw/null must NOT leave
  // the run wedged in 'preparing' with no error — mark it failed and release the
  // claim. opts.spawn remains as the legacy test seam and is adapted to a local
  // RunnerRef while preserving the returned pid in worker_pid.
  let pid = 1;
  let handle = outcome.scope;
  try {
    if (opts.spawn) {
      const spawned = await timeRunnerPhase(
        "runner_spawn",
        () => Promise.resolve(opts.spawn!(runId, outcome.scope)),
        { provider, fields: { runId, scope: outcome.scope } }
      );
      if (spawned == null) {
        return finish(await failSpawn(runId, outcome.scope, "run worker did not start (spawn returned no pid — worker image/runtime available?)"));
      }
      pid = spawned;
    } else if (lightweightChild) {
      // Lightweight tier: a memory-capped local Node child on the pi/postgres
      // path (NOT a docker/fly container). Same detached-spawn machinery as the
      // dev worker, minus the credential swap — DATABASE_URL is retained.
      const spawned = await timeRunnerPhase(
        "runner_spawn",
        () => Promise.resolve(spawnLightweightChild(runId, outcome.scope)),
        { provider, fields: { runId, scope: outcome.scope, lightweight: true } }
      );
      if (spawned == null) {
        return finish(await failSpawn(runId, outcome.scope, "lightweight child did not start (spawn returned no pid — node/tsx runtime available?)"));
      }
      pid = spawned;
    } else {
      const ref = await timeRunnerPhase(
        "runner_create",
        () => getRunnerProvider().create({ runId, scope: outcome.scope }),
        { provider, fields: { runId, scope: outcome.scope } }
      );
      if (!ref) {
        return finish(await failSpawn(runId, outcome.scope, "run worker did not start (spawn returned no pid — worker image/runtime available?)"));
      }
      handle = ref.handle;
    }
  } catch (err) {
    return finish(await failSpawn(runId, outcome.scope, `run worker failed to spawn: ${err instanceof Error ? err.message : String(err)}`));
  }
  // Condition the post-spawn write on THIS dispatch still owning the claim. A slow
  // create can outlast a sweep that declared the (container-less) run dead and
  // re-dispatched it: worker_scope then points at the winner's claim, and an
  // unconditional write here would repoint it back — driving one run with two
  // workers. If our token is gone we lost the race; leave the winner alone (its
  // orphaned container, if any, is reaped as a stray by the sweep).
  const owned = await db
    .update(agentSessions)
    .set({ workerPid: pid, workerScope: handle })
    .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, outcome.scope)));
  if (owned.count === 0) return finish("already-claimed");
  recordRunnerEvent("runner_spawned", { provider, runId, fields: { handle } });
  return finish("spawned");
}

async function failSpawn(runId: number, scope: string, message: string): Promise<DispatchResult> {
  // Only release + fail if THIS dispatch still owns the claim. A re-dispatch that
  // superseded us (see the post-spawn note) holds a healthy claim — nulling it and
  // marking the run failed would kill a live worker for a spawn that's no longer ours.
  const released = await db
    .update(agentSessions)
    .set({ workerScope: null, workerPid: null })
    .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, scope)));
  if (released.count === 0) return "already-claimed";
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
  // Half 0: reconcile against the REAL runner state — fast death detection +
  // log capture/state repair for anything the provider watcher missed.
  try {
    await getRunnerProvider().sweep();
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
      // Atomically take the terminal transition in ONE guarded write (status
      // column + status event in the same tx). Guarded against a claim that
      // raced our get() above: only fail a run still parked in 'pending' with no
      // worker. A dispatch that claimed it in that window owns it now — this write
      // must not clobber its healthy claim into 'failed'. Previously this was two
      // writes (a raw CAS UPDATE then a separate failRun) for one transition; a
      // connection death between them could land the event without the column
      // write and let the reaper mislabel the run.
      const failMsg =
        "no worker capacity: the run stayed queued past the maximum wait (TASK_ORCH_MAX_DEFER_MS) — worker slots (machines/memory) stayed full.";
      await runs().failPendingRun(id, failMsg);
      continue;
    }
    const r = await dispatchRun(id);
    if (r === "deferred") break;
  }
  // Half 3: fire due timers (docs/agent-events.md §7). Each fired timer becomes
  // a `timer.fired` inbox event whose emit-time wake dispatches its (parked)
  // target; late after downtime, never lost.
  try {
    await fireDueTimers();
  } catch {
    // best-effort
  }
  // Half 4: wake sweep (§6.2 belt). A wake lost between event insert and
  // dispatch (crash, race) is retried here every tick, forever, because the
  // state — parked + pending owner events — is durable. Bounded (the query
  // LIMITs and rides the pending-only partial index); continue on error.
  let parkedIds: number[] = [];
  try {
    parkedIds = await parkedRunsWithPendingEvents();
  } catch {
    parkedIds = [];
  }
  for (const id of parkedIds) {
    try {
      // 'parked' is claimable in dispatchRun (its claim excludes only
      // cancelled/closed), so a parked run resumes exactly like an idle chat
      // run: the worker's append/resume path injects the event digest.
      await dispatchRun(id);
    } catch {
      // continue with the rest; the next tick retries
    }
  }
}

/** Start the periodic pump (idempotent). Runs wherever a database is configured
 *  (DATABASE_URL set); disabled only by TASK_ORCH_PENDING_PUMP_MS=0.
 *
 *  Post-Phase-1 the pump is dev-safe on every half. Its two dispatch halves route
 *  through dispatchRun, which sends runtime='server' rows to the in-process resume
 *  path (no worker needed) and runtime='worker' rows to the provider — in dev that
 *  is detachedSpawn (a local tsx run-worker process), the same path emitInboxEvent's
 *  emit-time wake already uses; a run that can't be admitted simply stays 'pending'
 *  and is retried, never errors. Halves 3/4 (fireDueTimers + the parked wake sweep)
 *  are the reason to run in dev at all: without a ticking pump, run_timers never
 *  fire and a wake lost between event-insert and dispatch is never re-swept. The
 *  old gate (worker image / fly only) stranded all of that in dev. */
export function startPendingRunPump(): void {
  if (!process.env.DATABASE_URL) return;
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
  // Worker HTTP protocol (docs/worker-http-api.md): every worker gets a
  // run-scoped API token and talks to /api/worker over HTTP + SSE. Workers
  // hold NO database credentials — DATABASE_URL is deliberately absent.
  const env = [
    ...Object.entries(workerDispatchEnv(runId)).map(([k, v]) => `${k}=${v}`),
    pass("GH_TOKEN"),
    // Agent credentials for BOTH backends: the Claude auth pair plus every pi
    // provider key set on the server, so a worker dispatched with
    // TASK_ORCH_AGENT_BACKEND=pi can reach non-Anthropic providers too. Only
    // set keys are forwarded (an absent key stays absent in the container).
    ...AGENT_CREDENTIAL_ENV_KEYS.filter((k) => process.env[k] != null).map(pass),
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
      // Always resolve `host.docker.internal` inside the worker. In the compose
      // stack the worker reaches the server over the compose network instead, so
      // this is inert there; but for host dev (`npm run dev` + TASK_ORCH_WORKER_IMAGE)
      // the worker is on the default bridge and must reach the host server — on
      // Linux that needs the explicit host-gateway mapping (macOS Docker Desktop
      // provides it automatically; the duplicate is harmless).
      ExtraHosts: ["host.docker.internal:host-gateway"],
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

export async function dockerSpawn(runId: number, scope: string): Promise<number | null> {
  const docker = await getDocker();
  const container = await docker.createContainer(buildWorkerContainerConfig(runId, scope));
  await container.start();
  return 1; // sentinel: container started (not a host pid). cancel() uses the name.
}

// Shared core of both local-child spawn paths: a detached
// `node [execArgv] tsx scripts/run-worker.ts <id>` on the host. The two callers
// differ only in env + node flags — NOT in the launch mechanics — so they share
// this one implementation (no duplicated spawn/tsx-resolution logic).
function spawnLocalRunWorker(
  runId: number,
  opts: { env: NodeJS.ProcessEnv; execArgv?: string[] }
): number | null {
  const node = process.execPath;
  const tsx =
    process.env.TASK_ORCH_TSX_CLI || join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(tsx)) throw new Error(`tsx CLI not found at ${tsx} (set TASK_ORCH_TSX_CLI to override)`);
  const child = nodeSpawn(
    node,
    [...(opts.execArgv ?? []), tsx, "scripts/run-worker.ts", String(runId)],
    {
      cwd: process.cwd(),
      env: opts.env,
      detached: true,
      stdio: "ignore",
    }
  );
  child.on("error", () => {});
  child.unref();
  return child.pid ?? null;
}

// Dev fallback: a detached `tsx scripts/run-worker.ts <id>` on the host,
// speaking the worker HTTP protocol against this server (TASK_ORCH_WORKER_API_URL,
// or NEXTAUTH_URL in dev) with a run-scoped token and NO database credentials —
// the same contract as the container paths. No restart-survival, but dev
// doesn't redeploy.
function detachedSpawn(runId: number, _scope: string): number | null {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TASK_ORCH_INSIDE_WORKER: "1",
    ...workerDispatchEnv(runId),
  };
  delete env.DATABASE_URL;
  return spawnLocalRunWorker(runId, { env });
}

// Lightweight tier (runtime='server', isolation 'child'): a memory-capped local
// Node child that runs the pi turn OFF the web-server event loop while staying on
// the pi/postgres path. Unlike detachedSpawn it is NOT a worker — it inherits the
// full env INCLUDING DATABASE_URL (so runTransport picks the db transport and the
// child heartbeats + reaps exactly like an in-process server turn used to) and is
// NOT marked TASK_ORCH_INSIDE_WORKER. The only hard resource bound is a V8 heap
// cap (TASK_ORCH_LIGHTWEIGHT_MEMORY_MB) applied via --max-old-space-size, so a
// runaway turn is OOM-killed inside the child instead of taking the control plane
// down; that death is recovered by the reaper (reconcileOrphanedRuns), which
// re-dispatches server-resumable executors and idles chats. Concurrency is bounded
// by the admission cap in dispatchRun (TASK_ORCH_LIGHTWEIGHT_MAX_CHILDREN).
export function spawnLightweightChild(runId: number, _scope: string): number | null {
  const memMb = config.features.lightweightMemoryMb;
  const execArgv = memMb > 0 ? [`--max-old-space-size=${memMb}`] : [];
  return spawnLocalRunWorker(runId, { env: { ...process.env }, execArgv });
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

/** Provider-aware hard-stop used by run cancellation. */
export async function stopRunner(scope: string | null): Promise<void> {
  if (!scope) return;
  await getRunnerProvider().stop(scope);
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
    // Only worker-runtime claims correspond to containers. A lightweight
    // (runtime='server') claim's scope never appears in Docker's list by
    // construction, so "container doesn't exist" is meaningless for it —
    // declaring it dead after SWEEP_MIN_SILENCE_MS (30s) would reap healthy
    // in-process turns that are entitled to the 5-minute heartbeat contract
    // enforced by reconcileOrphanedRuns.
    if (run.runtime !== "worker") continue;
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
