import { describe, expect, it } from "vitest";
import {
  REVIEW_DEFAULT_BUDGET_USD,
  buildReviewPrompt,
  extractReviewOutcome,
} from "../lib/run-templates";
import type { TaskFull } from "../lib/types";

function fakeTask(overrides: Partial<TaskFull> = {}): TaskFull {
  return {
    id: "T-test",
    title: "Test task",
    state: "review",
    planId: "P-x",
    assignee: null,
    body: "Body text",
    estimate: null,
    tags: [],
    repoId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    dependencies: [],
    notes: [],
    criteria: [
      { id: 1, text: "first criterion", done: true, position: 0 },
      { id: 2, text: "second criterion", done: false, position: 1 },
    ],
    ...overrides,
  };
}

describe("buildReviewPrompt", () => {
  it("embeds the task id, title, PR url, and numbered criteria", () => {
    const prompt = buildReviewPrompt(
      fakeTask(),
      "https://github.com/o/r/pull/9"
    );
    expect(prompt).toContain("T-test");
    expect(prompt).toContain("# Test task");
    expect(prompt).toContain("https://github.com/o/r/pull/9");
    expect(prompt).toContain("1. [x] first criterion");
    expect(prompt).toContain("2. [ ] second criterion");
  });

  it("instructs the agent to emit a verdict JSON block", () => {
    const prompt = buildReviewPrompt(fakeTask(), "https://github.com/o/r/pull/1");
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain("approve");
    expect(prompt).toContain("request_changes");
    expect(prompt).toContain("comment");
    expect(prompt).toContain("concerns");
  });

  it("handles tasks with no criteria", () => {
    const prompt = buildReviewPrompt(
      fakeTask({ criteria: [] }),
      "https://github.com/o/r/pull/1"
    );
    expect(prompt).toContain("Acceptance criteria");
    expect(prompt).toContain("(none defined");
  });

  it("uses a smaller default budget than implement", () => {
    expect(REVIEW_DEFAULT_BUDGET_USD).toBeLessThan(20);
    expect(REVIEW_DEFAULT_BUDGET_USD).toBeGreaterThan(0);
  });
});

describe("extractReviewOutcome", () => {
  it("returns null for empty/null input", () => {
    expect(extractReviewOutcome(null)).toBeNull();
    expect(extractReviewOutcome(undefined)).toBeNull();
    expect(extractReviewOutcome("")).toBeNull();
    expect(extractReviewOutcome("   ")).toBeNull();
  });

  it("extracts a verdict from a fenced JSON block", () => {
    const text = [
      "Looks good to me overall.",
      "",
      "```json",
      JSON.stringify({
        verdict: "approve",
        summary: "All criteria satisfied.",
        concerns: [],
      }),
      "```",
    ].join("\n");
    const outcome = extractReviewOutcome(text);
    expect(outcome).not.toBeNull();
    const parsed = JSON.parse(outcome!);
    expect(parsed.verdict).toBe("approve");
    expect(parsed.summary).toBe("All criteria satisfied.");
  });

  it("extracts a verdict from a bare JSON object", () => {
    const text = `Final assessment:\n{"verdict":"request_changes","summary":"Missing tests","concerns":["no test for foo"]}`;
    const outcome = extractReviewOutcome(text);
    expect(outcome).not.toBeNull();
    const parsed = JSON.parse(outcome!);
    expect(parsed.verdict).toBe("request_changes");
  });

  it("prefers the last verdict block when multiple are present", () => {
    const text = [
      '{"verdict":"comment","summary":"first"}',
      "more text",
      '{"verdict":"approve","summary":"second"}',
    ].join("\n");
    const parsed = JSON.parse(extractReviewOutcome(text)!);
    expect(parsed.verdict).toBe("approve");
    expect(parsed.summary).toBe("second");
  });

  it("caps outcome at 200 characters", () => {
    const longSummary = "x".repeat(500);
    const text = JSON.stringify({
      verdict: "approve",
      summary: longSummary,
      concerns: [],
    });
    const outcome = extractReviewOutcome(text);
    expect(outcome).not.toBeNull();
    expect(outcome!.length).toBeLessThanOrEqual(200);
  });

  it("falls back to the first non-empty line when no verdict block present", () => {
    const text = "PR looks fine but I didn't follow the verdict format.\nMore text below.";
    const outcome = extractReviewOutcome(text);
    expect(outcome).toBe("PR looks fine but I didn't follow the verdict format.");
  });

  it("ignores invalid JSON that mentions verdict", () => {
    // No valid JSON object, only invalid syntax.
    const text = '"verdict": "approve" but not really\nSecond line.';
    const outcome = extractReviewOutcome(text);
    // No JSON object found → falls back to first line.
    expect(outcome).toBe('"verdict": "approve" but not really');
  });
});
