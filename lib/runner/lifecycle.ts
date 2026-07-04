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
}

const DAY_MS = 24 * 60 * 60 * 1000;

function intEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
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
