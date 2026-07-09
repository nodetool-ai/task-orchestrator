// lib/run-liveness.ts
//
// The single home for the run liveness lease (heartbeat) — its constants, its
// predicates, and the shared "a worker died, now what?" resume policy. Before
// R8 the 5-minute stale window was written THREE times (runs.ts, run-dispatch.ts,
// runner/lifecycle.ts) each with a "keep in sync" comment, the worker-liveness
// predicate lived in three near-identical copies, and the two reapers
// (reconcileOrphanedRuns, handleWorkerDeath) re-implemented the same re-dispatch
// decision with subtly different existence gates.
//
// DEPENDENCY-LIGHT ON PURPOSE. This is a leaf: it imports only run-state (the
// status vocabulary) and nothing from runs.ts / run-dispatch.ts. run-dispatch
// must not import runs.ts (the injected-RunsApi split avoids a boot cycle), and
// both import from here — so this module owes them a dependency-free surface.

import { LEASE_STATUSES, type SessionStatus } from "./run-state";

/** How often a live turn bumps its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Age past which an active-status run is considered orphaned. Must comfortably
 * exceed HEARTBEAT_INTERVAL_MS and any plausible pause between bumps (the
 * interval keeps ticking even while a slow model/tool call is awaited, so this
 * only needs slack for scheduling jitter / GC pauses). This is the ONE stale
 * window — the former WORKER_CLAIM_STALE_MS copies in run-dispatch.ts and
 * runner/lifecycle.ts were this same value and now import it from here.
 */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** True when this run holds a live lease: an active (turn-in-flight) status
 *  with a heartbeat fresher than the stale window. Unlike isWorkerLive this is
 *  false the moment the run leaves a lease status (e.g. a chat parked at
 *  'idle'), even while a worker still owns it. */
export function isLeaseLive(
  run: { status: string; heartbeatAt: Date | null },
  now = Date.now()
): boolean {
  if (!LEASE_STATUSES.includes(run.status as SessionStatus)) return false;
  return run.heartbeatAt != null && now - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS;
}

/**
 * True when a worker container owns this run and is still alive — a worker_scope
 * set plus a fresh heartbeat — REGARDLESS of status. Unlike isLeaseLive this
 * stays true for a long-lived chat worker parked at 'idle' between turns (idle
 * is not a lease status) and for a plan-executor mid-turn at 'running'. The
 * server uses it to choose notify-only (a live worker will pick up the input)
 * vs dispatching a fresh worker; the sweep re-checks it immediately before a
 * suspend/stop (the decision snapshot can go stale before the action executes).
 *
 * This is the single definition that replaced runs.ts's isWorkerLive,
 * run-dispatch's hasLiveWorkerClaim, and lifecycle's isWorkerClaimLive.
 */
export function isWorkerLive(
  run: { workerScope?: string | null; heartbeatAt?: Date | null },
  now = Date.now()
): boolean {
  return (
    run.workerScope != null &&
    run.heartbeatAt != null &&
    now - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS
  );
}

/**
 * Whether a dead run can be resumed by handing it to a FRESH worker, rather than
 * failed. A worktree implement run is resumable — its branch/worktree persist
 * and it has an SDK session to resume from.
 *
 * The existence gate (R8 reconciliation): a REMOTE runner (Fly Machine or Docker
 * worker) re-clones from the branch pushed to GitHub, so `hasBranch` is enough —
 * and on Fly worktreePath is a runner-volume path (/mnt/session/repo) that never
 * exists on the server, so an on-disk check would wrongly fail every remote
 * orphan. A host/dev run instead needs its worktree still on this disk. Both
 * reapers now pass `remote = remoteRunnerEnabled()` for this bit; previously
 * reconcileOrphanedRuns used remoteRunnerEnabled() while handleWorkerDeath used
 * `!!TASK_ORCH_WORKER_IMAGE`. In the Docker-die context those two agree
 * (WORKER_IMAGE is set there, and remoteRunnerEnabled() reduces to its presence
 * given detached); unifying on remoteRunnerEnabled() also makes the death
 * handler correct were it ever reached on Fly.
 */
export function isResumableDeadRun(i: {
  detached: boolean;
  remote: boolean;
  isImplementWorktree: boolean;
  hasSdkSession: boolean;
  hasBranch: boolean;
  worktreeOnDisk: boolean;
}): boolean {
  return (
    i.detached &&
    i.isImplementWorktree &&
    i.hasSdkSession &&
    (i.remote ? i.hasBranch : i.worktreeOnDisk)
  );
}

export type DeadRunPolicy = "redispatch" | "idle" | "failed";

/**
 * The shared resume policy both reapers apply to a run whose worker died:
 *   - resumable implement run, NOT OOM-killed → re-dispatch to a fresh worker
 *   - chat run → back to 'idle' (resumable on the next message)
 *   - everything else → failed
 *
 * The OOM carve-out: an OOM-killed container would be re-killed at the same
 * memory cap at the same spot, so a visible failure beats a silent kill loop.
 * reconcileOrphanedRuns (the heartbeat sweep) has no OOM signal — it only knows
 * the heartbeat went stale — so it passes oom=false, and its resumable orphans
 * always re-dispatch, exactly as before. handleWorkerDeath passes the real
 * Docker-die OOM verdict. The sweep's completed-event recovery (a completion
 * event that outlived a lost terminal write) is a sweep-only PRE-check that runs
 * before this policy — it stays at the call site, not here.
 */
export function decideDeadRunPolicy(i: {
  goal: string;
  resumable: boolean;
  oom: boolean;
}): DeadRunPolicy {
  if (i.resumable && !i.oom) return "redispatch";
  if (i.goal === "<chat>") return "idle";
  return "failed";
}
