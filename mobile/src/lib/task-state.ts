// Task state machine — mirrors the server's lib/types.ts (TASK_STATES,
// STATE_LABEL, TASK_TRANSITIONS) so the app speaks the same vocabulary the
// REST API enforces. PR-backed tasks move through testing/failing/passing/
// merged as GitHub CI reports in; `review`/`done` are NOT task states (that was
// an older schema the mobile client shipped against).

import type { RunState } from "@/theme";
import type { TaskState } from "./types";

export const STATE_LABEL: Record<TaskState, string> = {
  todo: "Todo",
  in_progress: "In progress",
  testing: "Testing",
  failing: "Failing",
  passing: "Passing",
  merged: "Merged",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

// Allowed next states, verbatim from the server's TASK_TRANSITIONS. The server
// rejects any edge not listed here, so the state-changer only offers these.
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["testing", "failing", "passing", "merged", "blocked", "cancelled"],
  testing: ["passing", "failing", "merged", "blocked", "cancelled"],
  failing: ["testing", "passing", "merged", "blocked", "cancelled"],
  passing: ["merged", "testing", "failing", "blocked", "cancelled"],
  blocked: ["in_progress", "testing", "failing", "passing", "merged", "cancelled"],
  merged: [],
  cancelled: [],
};

// The set of PR-backed states that mean "an agent opened a PR and it's waiting
// on CI / your review" — the mobile "review" bucket. Mirrors the glyph mapping
// in the server's lib/pi-floor-data.ts.
export const REVIEW_STATES = new Set<TaskState>(["testing", "failing", "passing"]);

export function isReviewState(s: TaskState): boolean {
  return REVIEW_STATES.has(s);
}

export function isTerminalState(s: TaskState): boolean {
  return s === "merged" || s === "cancelled";
}

// Map a task state onto the six-glyph run-state palette used by StateIcon /
// StatePill. testing/failing/passing all read as the "review" glyph; merged as
// "done". Matches lib/pi-floor-data.ts so mobile and web look identical.
export function taskGlyph(s: TaskState): RunState {
  switch (s) {
    case "todo":
      return "todo";
    case "in_progress":
      return "in_progress";
    case "testing":
    case "failing":
    case "passing":
      return "review";
    case "merged":
      return "done";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
  }
}
