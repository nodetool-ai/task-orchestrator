// __tests__/events-tools.test.ts
//
// Unit tests for the PURE helpers in lib/extensions/events.ts (the always-on
// timer__*/events__*/report_result/raise/ask_parent/answer_question tools,
// docs/agent-events.md). DB-backed behavior is exercised elsewhere; these
// cover the state-machine/gating logic that doesn't need a database.

import { describe, expect, it } from "vitest";
import {
  checkAnswerable,
  checkCustomEventType,
  isWithinCallerTree,
  type PendingQuestion,
} from "../lib/extensions/events";

function makeQuestion(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    question_id: "q-1-1000",
    question: "Which base branch?",
    asked_at: "2026-07-05T00:00:00.000Z",
    deadline: "2026-07-05T01:00:00.000Z",
    state: "open",
    ...overrides,
  };
}

describe("checkAnswerable (§8 question state machine)", () => {
  it("allows answering an open question with a matching id", () => {
    expect(checkAnswerable(makeQuestion(), "q-1-1000")).toBeNull();
  });

  it("rejects when there is no pending question at all", () => {
    const err = checkAnswerable(null, "q-1-1000");
    expect(err).toMatch(/No open question/);
  });

  it("rejects when the question_id doesn't match the run's pending question", () => {
    const err = checkAnswerable(makeQuestion({ question_id: "q-1-9999" }), "q-1-1000");
    expect(err).toMatch(/No open question/);
  });

  it("rejects an already-answered question, naming when it was answered", () => {
    const err = checkAnswerable(
      makeQuestion({ state: "answered", answered_at: "2026-07-05T00:30:00.000Z" }),
      "q-1-1000"
    );
    expect(err).toMatch(/already answered/);
    expect(err).toContain("2026-07-05T00:30:00.000Z");
  });

  it("rejects an expired question and surfaces the recorded assumption", () => {
    const err = checkAnswerable(
      makeQuestion({ state: "expired", assumption: "proceeded with main as base" }),
      "q-1-1000"
    );
    expect(err).toMatch(/expired/);
    expect(err).toContain("proceeded with main as base");
  });

  it("rejects an expired question with no assumption recorded, without crashing", () => {
    const err = checkAnswerable(makeQuestion({ state: "expired" }), "q-1-1000");
    expect(err).toMatch(/expired/);
  });
});

describe("checkCustomEventType (§3.6 events__emit guard)", () => {
  it("accepts types prefixed 'custom.'", () => {
    expect(checkCustomEventType("custom.interface_changed")).toBeNull();
  });

  it("rejects platform taxonomy types the agent must not forge", () => {
    for (const type of ["child.result", "gh.pr.merged", "timer.fired", "task.transitioned"]) {
      expect(checkCustomEventType(type)).toMatch(/only accepts types prefixed 'custom\.'/);
    }
  });

  it("rejects control-class types even if somehow prefixed 'custom.'", () => {
    // Defense in depth: CONTROL_TYPES has no 'custom.' members today, but the
    // guard checks it independently of the prefix check.
    expect(checkCustomEventType("run.cancel_requested")).not.toBeNull();
  });
});

describe("isWithinCallerTree (§3.6 tree-membership check)", () => {
  it("is true when both roots resolve to the same run id", () => {
    expect(isWithinCallerTree(1, 1)).toBe(true);
  });

  it("is false when the target belongs to a different tree", () => {
    expect(isWithinCallerTree(1, 2)).toBe(false);
  });
});
