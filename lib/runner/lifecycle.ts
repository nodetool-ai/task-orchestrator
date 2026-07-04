// lib/runner/lifecycle.ts
import type { RunnerState } from "./provider";
import { isTerminalStatus, type SessionStatus } from "../types";

export type LifecycleAction =
  | { kind: "none" }
  | { kind: "suspend" }
  | { kind: "stop" }
  | { kind: "archive-and-destroy" };

export interface LifecycleInput {
  runStatus: string;
  runnerState: RunnerState;
  /** Milliseconds since the last run/runner activity. */
  idleMs: number;
  /** agent_sessions.worker_scope for this run, if the sweep's row has it.
   *  Combined with heartbeatAt below to decide claim liveness (see
   *  isWorkerClaimLive) — independent of runStatus. Optional/undefined is
   *  treated as "no claim" (existing callers that omit it keep today's
   *  status-only behavior). */
  workerScope?: string | null;
  /** agent_sessions.heartbeat_at for this run. */
  heartbeatAt?: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

// Mirrors runs.ts's HEARTBEAT_STALE_MS. Duplicated here (not imported) because
// lifecycle.ts is a pure, dependency-free policy module and must not import
// runs.ts. Keep this in sync if that value ever changes.
const WORKER_CLAIM_STALE_MS = 5 * 60_000;

/**
 * True when a run's detached worker claim (worker_scope set + a fresh
 * heartbeat) is still live, independent of runStatus. A chat worker
 * idle-waiting within its own idle timeout holds this at runStatus='idle' (not
 * a lease status); a plan-executor mid-turn holds it at 'running'. Exported so
 * fly.ts can re-apply the identical check immediately before executing a
 * suspend/stop, since the sweep's decision snapshot can go stale between the
 * decision and the action actually executing.
 */
export function isWorkerClaimLive(i: { workerScope?: string | null; heartbeatAt?: Date | null }): boolean {
  return (
    i.workerScope != null &&
    i.heartbeatAt != null &&
    Date.now() - i.heartbeatAt.getTime() < WORKER_CLAIM_STALE_MS
  );
}

function isActiveRunStatus(status: string): boolean {
  return (
    status === "pending" ||
    status === "preparing" ||
    status === "running" ||
    status === "pushing" ||
    status === "opening_pr"
  );
}

/**
 * Pure lifecycle policy for cost control:
 * - active runs are never touched;
 * - idle/done runs on a running machine are suspended first;
 * - once idle past TASK_ORCH_RUNNER_SUSPEND_MS (default 24h), suspended machines
 *   are stopped;
 * - once idle past TASK_ORCH_RUNNER_STOP_MS (default 7d), stopped machines are
 *   archived/destroyed.
 */
export function nextLifecycleAction(i: LifecycleInput): LifecycleAction {
  const state = i.runnerState;
  if (state === "gone" || state === "creating" || state === "starting") return { kind: "none" };

  // A live worker claim means something is ACTIVELY using this machine right
  // now, regardless of runStatus — checked before anything status-based below.
  // Suspending/stopping out from under a claim-holder either strands an
  // in-flight message (server sees a live worker, NOTIFYs only, then the
  // machine freezes before it processes the notify and the claim is cleared —
  // the message waits for the next one) or freezes a genuinely live turn and
  // strips its claim. Only once the worker itself releases the claim (a
  // parked chat worker winds down after its own idle timeout; an executor
  // finishes its turn) does the machine become eligible for suspend/stop.
  if (isWorkerClaimLive(i)) return { kind: "none" };

  const terminal = isTerminalStatus(i.runStatus as SessionStatus);
  if (!terminal && isActiveRunStatus(i.runStatus)) return { kind: "none" };

  const suspendWindowMs = intEnv("TASK_ORCH_RUNNER_SUSPEND_MS", DAY_MS);
  const stopWindowMs = intEnv("TASK_ORCH_RUNNER_STOP_MS", 7 * DAY_MS);

  if (i.idleMs >= stopWindowMs) {
    return state === "stopped" ? { kind: "archive-and-destroy" } : { kind: "stop" };
  }
  if (i.idleMs >= suspendWindowMs) {
    return state === "running" || state === "suspended" ? { kind: "stop" } : { kind: "none" };
  }
  if (state === "running") return { kind: "suspend" };
  return { kind: "none" };
}
