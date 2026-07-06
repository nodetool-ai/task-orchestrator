import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REVIEW_DEFAULT_BUDGET_USD,
  buildChatPromptPrefix,
  buildImplementPrompt,
  buildPlanChatPromptPrefix,
  buildReviewPrompt,
  extractReviewOutcome,
  parseReviewVerdict,
} from "../lib/run-templates";
import * as repo from "../lib/repo";
import * as worker from "../lib/worker";
import type { PlanFull, TaskFull } from "../lib/types";

function fakeTask(overrides: Partial<TaskFull> = {}): TaskFull {
  return {
    id: "T-test",
    title: "Test task",
    state: "testing",
    planId: "P-x",
    assignee: null,
    body: "Body text",
    estimate: null,
    tags: [],
    repoId: null,
    prUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    dependencies: [],
    notes: [],
    criteria: [
      { id: 1, text: "first criterion", done: true, position: 0 },
      { id: 2, text: "second criterion", done: false, position: 1 },
    ],
    attachments: [],
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

  it("flags the shared node_modules / build cache across worktrees", () => {
    const prompt = buildReviewPrompt(fakeTask(), "https://github.com/o/r/pull/1");
    expect(prompt).toContain("SHARED across all worktrees");
    expect(prompt).toContain("node_modules");
  });
});

describe("buildImplementPrompt", () => {
  it("describes the worktree working environment", async () => {
    const prompt = await buildImplementPrompt(fakeTask());
    expect(prompt).toContain("isolated git worktree");
  });

  it("flags the shared node_modules / build cache across worktrees", async () => {
    const prompt = await buildImplementPrompt(fakeTask());
    expect(prompt).toContain("SHARED across all worktrees");
    expect(prompt).toContain("node_modules");
    expect(prompt).toContain("Turbopack");
  });

  it("tells the agent how to get a private/isolated environment", async () => {
    const prompt = await buildImplementPrompt(fakeTask());
    expect(prompt).toContain("npm run isolate-env");
  });

  it("tells the agent how to start a securely-exposed dev server", async () => {
    const prompt = await buildImplementPrompt(fakeTask());
    expect(prompt).toContain("npm run worktree-dev");
    expect(prompt).toContain("loopback");
  });

  // Regression (#98 fleet outage): buildImplementPrompt runs INSIDE a dispatched
  // worker, which under the HTTP-worker architecture has no DB access — every
  // direct repo/db call throws the "Direct database access inside a run worker"
  // guard and crashes the run at boot. The plan + sibling-task lookups must go
  // through the worker transport, never `repo` directly. This asserts BOTH the
  // plan and the sibling snapshot route through the transport, and that repo is
  // never touched. (The shipped bug: getPlan used the transport but the sibling
  // `listTasks` still called `repo.listTasks` → 6/6 implement workers dead.)
  describe("routes all orchestrator lookups through the worker transport (no direct DB)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("fetches the plan AND sibling tasks via runTransport, not repo", async () => {
      const plan = {
        id: "P-x",
        title: "Parent plan",
        state: "active",
        owner: null,
        body: "plan body",
      } as unknown as PlanFull;
      const siblings = [
        fakeTask({ id: "T-sibling", title: "A sibling task", state: "todo" }),
        fakeTask({ id: "T-test" }), // the task itself — must be filtered out
      ];
      const getPlan = vi.fn().mockResolvedValue(plan);
      const listTasks = vi.fn().mockResolvedValue(siblings);
      vi.spyOn(worker, "runTransport").mockResolvedValue({ getPlan, listTasks } as never);
      const repoListTasks = vi.spyOn(repo, "listTasks");

      const prompt = await buildImplementPrompt(fakeTask({ id: "T-test", planId: "P-x" }));

      expect(getPlan).toHaveBeenCalledWith("P-x");
      expect(listTasks).toHaveBeenCalledWith({ planId: "P-x" });
      expect(repoListTasks).not.toHaveBeenCalled(); // never the direct-DB path
      expect(prompt).toContain("# Parent plan: P-x — Parent plan");
      expect(prompt).toContain("- T-sibling [todo] A sibling task");
      expect(prompt).not.toContain("- T-test ["); // the run's own task filtered out
    });
  });
});

describe("buildChatPromptPrefix", () => {
  it("includes task id, title, body and criteria", () => {
    const prefix = buildChatPromptPrefix(fakeTask());
    expect(prefix).toContain("T-test");
    expect(prefix).toContain('"Test task"');
    expect(prefix).toContain("Body text");
    expect(prefix).toContain("- [x] first criterion");
    expect(prefix).toContain("- [ ] second criterion");
  });

  it("includes recent notes when present", () => {
    const prefix = buildChatPromptPrefix(
      fakeTask({
        notes: [
          { id: 1, author: "matti", body: "first note", createdAt: new Date() },
          { id: 2, author: "claude", body: "second note", createdAt: new Date() },
        ],
      })
    );
    expect(prefix).toContain("Recent notes");
    expect(prefix).toContain("@matti: first note");
    expect(prefix).toContain("@claude: second note");
  });

  it("includes the latest PR url when provided", () => {
    const prefix = buildChatPromptPrefix(
      fakeTask(),
      "https://github.com/o/r/pull/42"
    );
    expect(prefix).toContain("Latest PR");
    expect(prefix).toContain("https://github.com/o/r/pull/42");
  });

  it("omits the PR section when no PR url is given", () => {
    const prefix = buildChatPromptPrefix(fakeTask());
    expect(prefix).not.toContain("Latest PR");
  });

  it("omits the criteria section when the task has no criteria", () => {
    const prefix = buildChatPromptPrefix(fakeTask({ criteria: [] }));
    expect(prefix).not.toContain("Acceptance criteria");
  });
});

function fakePlan(overrides: Partial<PlanFull> = {}): PlanFull {
  return {
    id: "P-2026-01-01-test-plan",
    title: "Test plan",
    state: "draft",
    owner: null,
    body: "Plan body text",
    tags: [],
    repos: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    attachments: [],
    ...overrides,
  };
}

describe("buildPlanChatPromptPrefix", () => {
  it("includes plan id, title, state and body", () => {
    const prefix = buildPlanChatPromptPrefix(fakePlan(), []);
    expect(prefix).toContain("P-2026-01-01-test-plan");
    expect(prefix).toContain('"Test plan"');
    expect(prefix).toContain("state: draft");
    expect(prefix).toContain("Plan body text");
  });

  it("lists tasks grouped sensibly when present", () => {
    const prefix = buildPlanChatPromptPrefix(fakePlan(), [
      fakeTask({ id: "T-1", state: "in_progress", title: "Working" }),
      fakeTask({ id: "T-2", state: "todo", title: "Up next" }),
    ]);
    expect(prefix).toContain("## Tasks (2)");
    expect(prefix).toContain("T-1");
    expect(prefix).toContain("Working");
    expect(prefix).toContain("T-2");
    // in_progress sorts before todo
    expect(prefix.indexOf("T-1")).toBeLessThan(prefix.indexOf("T-2"));
  });

  it("renders '(none yet)' when the plan has no tasks", () => {
    const prefix = buildPlanChatPromptPrefix(fakePlan(), []);
    expect(prefix).toContain("## Tasks");
    expect(prefix).toContain("(none yet)");
  });

  it("instructs the agent to act through the orchestrator MCP tools", () => {
    const prefix = buildPlanChatPromptPrefix(fakePlan(), []);
    expect(prefix).toContain("How to act on this plan");
    expect(prefix).toContain("create_task");
    expect(prefix).toContain("update_plan");
    expect(prefix).toContain("plan_id");
  });

  it("includes attached repositories", () => {
    const prefix = buildPlanChatPromptPrefix(
      fakePlan({
        repos: [
          {
            id: "R-one",
            name: "one",
            remote: null,
            localPath: null,
            defaultBranch: "main",
            description: "",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
      []
    );
    expect(prefix).toContain("Repositories:");
    expect(prefix).toContain("R-one");
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

  it("stays valid JSON (verdict recoverable) when the summary can't absorb the overflow", () => {
    // A long verdict with a short summary used to push the serialized object
    // over 200 chars, and the old slice(0,200) fallback corrupted the JSON so
    // parseReviewVerdict silently dropped the verdict (blocking approve→done).
    const text = JSON.stringify({ verdict: "approve_" + "x".repeat(250), summary: "ok" });
    const outcome = extractReviewOutcome(text);
    expect(outcome).not.toBeNull();
    // Must round-trip as JSON and preserve the verdict.
    const parsed = JSON.parse(outcome!);
    expect(parsed.verdict).toBe("approve_" + "x".repeat(250));
  });

  it("caps a long summary while keeping the outcome parseable", () => {
    const text = JSON.stringify({ verdict: "approve", summary: "y".repeat(400) });
    const outcome = extractReviewOutcome(text);
    expect(outcome!.length).toBeLessThanOrEqual(200);
    expect(parseReviewVerdict(outcome)).toBe("approve");
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

  it("extracts the verdict even when prose has an odd number of double-quotes", () => {
    // An inch mark (27") leaves an unpaired quote in the prose before the JSON
    // block. The old scanner toggled inString on every quote at depth 0, so it
    // entered the block "in a string" and swallowed the opening brace, dropping
    // the verdict and stranding the review (approve → done never fired).
    const text = [
      'Renders fine on a 27" display and the layout holds up.',
      "",
      "```json",
      JSON.stringify({ verdict: "approve", summary: "All criteria satisfied." }),
      "```",
    ].join("\n");
    const outcome = extractReviewOutcome(text);
    expect(outcome).not.toBeNull();
    expect(parseReviewVerdict(outcome)).toBe("approve");
  });
});

describe("parseReviewVerdict", () => {
  it("returns null for empty input", () => {
    expect(parseReviewVerdict(null)).toBeNull();
    expect(parseReviewVerdict(undefined)).toBeNull();
    expect(parseReviewVerdict("")).toBeNull();
  });

  it("reads the verdict back out of an extracted outcome", () => {
    const outcome = extractReviewOutcome(
      'Looks good.\n{"verdict": "approve", "summary": "All criteria met."}'
    );
    expect(parseReviewVerdict(outcome)).toBe("approve");
  });

  it("returns the non-approve verdict verbatim", () => {
    const outcome = extractReviewOutcome(
      '{"verdict": "request_changes", "summary": "Missing tests."}'
    );
    expect(parseReviewVerdict(outcome)).toBe("request_changes");
  });

  it("returns null for the plain-text fallback outcome", () => {
    // extractReviewOutcome falls back to the first line when no JSON verdict
    // block is present — that text has no parseable verdict.
    const outcome = extractReviewOutcome("Looks fine to me.");
    expect(outcome).toBe("Looks fine to me.");
    expect(parseReviewVerdict(outcome)).toBeNull();
  });
});
