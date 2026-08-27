// lib/runner/lifecycle.ts
import type { RunnerState } from "./provider";
import { isTerminalStatus, type SessionStatus } from "../types";

export interface LifecycleInput {
  runStatus: string;
  runnerState: RunnerState;
  /** Milliseconds since the last run/runner activity. */
  idleMs: number;
  /** The provider's verdict for this run's worker (resolveLiveness === "alive",
   *  or inspect() alive). Callers pass `true` for "unknown" as well: an
   *  unobservable worker is never a reason to destroy its runner. */
  workerLive: boolean;
  /** agent_runs.goal ('<execute>', '<chat>', a task goal, …). Used with
   *  runStatus to classify conversational terminal runs. */
  goal?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** Terminal statuses dispatchRun will happily re-claim for a follow-up turn
 *  (everything terminal except the hard stops cancelled/closed). */
const REVIVABLE_TERMINAL_STATUSES = new Set(["completed", "failed", "budget_exhausted"]);

/**
 * True for a run whose terminal status is conversational, not final. A plan
 * executor (goal='<execute>') lands `completed` after EVERY turn — that is how
 * await_session/the UI see the turn finish — but the operator steers it with
 * follow-up messages between turns. Its machine+volume hold the warm checkout
 * and the SDK session transcript, so classifying it under the short terminal
 * window destroys the conversation's memory an hour after each reply; these
 * runs must age through the long resumable windows instead. cancelled/closed
 * stay terminal: dispatchRun never revives them.
 */
export function isConversationalTerminal(i: { runStatus: string; goal?: string | null }): boolean {
  return i.goal === "<execute>" && REVIVABLE_TERMINAL_STATUSES.has(i.runStatus);
}

function isActiveRunStatus(status: string): boolean {
  return status === "pending" || status === "preparing" || status === "running";
}

/**
 * The one lifecycle question a sprites runner has: destroy or keep. Sprites
 * hibernate themselves, so there is no suspend/stop ladder and no wake intent.
 *
 * Rules in order:
 * 1. `runnerState` is `gone`, `creating`, or `starting` → `none`.
 * 2. `workerLive` → `none`.
 * 3. Terminal, non-conversational run with `idleMs >= TASK_ORCH_RUNNER_TERMINAL_MS` (default 24h) → `destroy`.
 * 4. Active run status → `none`.
 * 5. Otherwise (idle/parked/conversational-terminal) with `idleMs >= TASK_ORCH_RUNNER_STOP_MS` (default 7d) → `destroy`.
 * 6. Else `none`.
 */
export type SpritesLifecycleAction = { kind: "none" } | { kind: "destroy" };

export function nextSpritesLifecycleAction(i: LifecycleInput): SpritesLifecycleAction {
  const state = i.runnerState;
  if (state === "gone" || state === "creating" || state === "starting") return { kind: "none" };

  if (i.workerLive) return { kind: "none" };

  if (isTerminalStatus(i.runStatus as SessionStatus) && !isConversationalTerminal(i)) {
    const terminalWindowMs = intEnv("TASK_ORCH_RUNNER_TERMINAL_MS", DAY_MS);
    if (i.idleMs >= terminalWindowMs) return { kind: "destroy" };
    return { kind: "none" };
  }

  if (isActiveRunStatus(i.runStatus)) return { kind: "none" };

  const stopWindowMs = intEnv("TASK_ORCH_RUNNER_STOP_MS", 7 * DAY_MS);
  if (i.idleMs >= stopWindowMs) return { kind: "destroy" };

  return { kind: "none" };
}
