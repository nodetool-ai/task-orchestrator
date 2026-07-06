// __tests__/task-states.test.ts
//
// Pure unit tests for the task state machine (lib/types.ts). The lifecycle is
// todo → in_progress → testing ⇄ failing → passing → merged, plus blocked and
// cancelled. `review` and `done` are NOT task states (they were removed —
// `done` survives only as a PLAN state, which lives in PLAN_STATES).

import { describe, expect, it } from "vitest";
import {
  PLAN_STATES,
  STATE_LABEL,
  TASK_BOARD_STATES,
  TASK_STATES,
  TASK_TRANSITIONS,
  type TaskState,
} from "../lib/types";

describe("TASK_STATES", () => {
  it("is the GitHub-driven set and excludes the removed review/done states", () => {
    expect([...TASK_STATES]).toEqual([
      "todo",
      "in_progress",
      "testing",
      "failing",
      "passing",
      "merged",
      "blocked",
      "cancelled",
    ]);
    expect(TASK_STATES).not.toContain("review");
    expect(TASK_STATES).not.toContain("done");
  });
});

describe("TASK_TRANSITIONS", () => {
  it("encodes the new lifecycle edges", () => {
    expect(TASK_TRANSITIONS.todo).toEqual(["in_progress", "cancelled"]);
    expect(TASK_TRANSITIONS.in_progress).toEqual([
      "testing",
      "failing",
      "passing",
      "merged",
      "blocked",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.testing).toEqual([
      "passing",
      "failing",
      "merged",
      "blocked",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.failing).toEqual([
      "testing",
      "passing",
      "merged",
      "blocked",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.passing).toEqual([
      "merged",
      "testing",
      "failing",
      "blocked",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.blocked).toEqual([
      "in_progress",
      "testing",
      "failing",
      "passing",
      "merged",
      "cancelled",
    ]);
  });

  it("makes merged and cancelled terminal", () => {
    expect(TASK_TRANSITIONS.merged).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  // Invariant that prevents CRITICAL stranding: a merged PR is authoritative and
  // CI can flip pass/fail anytime, so every non-terminal PR-backed state must
  // accept every state prToTaskState can derive. Otherwise applyTaskStateFromPr
  // silently no-ops and the task never reaches merged (e.g. a PR merged while a
  // non-required check is red would strand a `failing` task forever).
  it("lets every non-terminal PR-backed state reach all GitHub-derived states", () => {
    const ghDerivable: TaskState[] = ["testing", "failing", "passing", "blocked", "merged"];
    for (const from of ["in_progress", "testing", "failing", "passing", "blocked"] as TaskState[]) {
      for (const to of ghDerivable) {
        if (to === from) continue;
        expect(TASK_TRANSITIONS[from]).toContain(to);
      }
    }
  });

  it("has no keys for the removed review/done task states", () => {
    expect(Object.keys(TASK_TRANSITIONS)).not.toContain("review");
    expect(Object.keys(TASK_TRANSITIONS)).not.toContain("done");
  });

  it("only ever targets valid task states", () => {
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const t of targets) expect(TASK_STATES).toContain(t);
    }
  });
});

describe("TASK_BOARD_STATES", () => {
  it("is the open-column set — merged is the closed/terminal column, not a board column", () => {
    expect([...TASK_BOARD_STATES]).toEqual([
      "todo",
      "in_progress",
      "testing",
      "failing",
      "passing",
      "blocked",
    ]);
    expect(TASK_BOARD_STATES).not.toContain("merged");
  });
});

describe("STATE_LABEL", () => {
  it("labels every task state and drops the review task label", () => {
    for (const s of TASK_STATES) expect(STATE_LABEL[s]).toBeTruthy();
    expect(STATE_LABEL).not.toHaveProperty("review");
  });

  it("keeps the plan `done` label (plans still terminate at done)", () => {
    expect(PLAN_STATES).toContain("done");
    expect(STATE_LABEL.done).toBe("Done");
    for (const s of PLAN_STATES) expect(STATE_LABEL[s]).toBeTruthy();
  });
});
