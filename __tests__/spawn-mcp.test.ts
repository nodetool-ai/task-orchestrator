import { describe, expect, it } from "vitest";
import {
  computeDepth,
  sumTreeCost,
  checkTreeBudget,
  checkAppendableStatus,
  extractLatestAssistantText,
  MAX_DEPTH,
  DEFAULT_TREE_BUDGET_MULT,
} from "../lib/spawn-mcp";

describe("computeDepth", () => {
  it("root run (empty chain) is depth 0", () => {
    expect(computeDepth([])).toBe(0);
  });

  it("immediate child of root is depth 1", () => {
    expect(computeDepth([{ parentRunId: null }])).toBe(1);
  });

  it("grandchild is depth 2", () => {
    expect(
      computeDepth([
        { parentRunId: 1 },
        { parentRunId: null },
      ])
    ).toBe(2);
  });

  it("great-grandchild (parent chain length 3) is at the cap", () => {
    const chain = [
      { parentRunId: 2 },
      { parentRunId: 1 },
      { parentRunId: null },
    ];
    expect(computeDepth(chain)).toBe(MAX_DEPTH);
  });

  it("a parent whose own depth is 3 cannot spawn further (newChildDepth would be 4)", () => {
    // The spawn handler uses parentChain.length + 1 to compute newChildDepth.
    const parentChain = [
      { parentRunId: 2 },
      { parentRunId: 1 },
      { parentRunId: null },
    ];
    const parentDepth = computeDepth(parentChain);
    const newChildDepth = parentDepth + 1;
    expect(newChildDepth).toBe(4);
    expect(newChildDepth > MAX_DEPTH).toBe(true);
  });

  it("a parent at depth 2 can still spawn (child lands at depth 3)", () => {
    const parentChain = [
      { parentRunId: 1 },
      { parentRunId: null },
    ];
    const newChildDepth = computeDepth(parentChain) + 1;
    expect(newChildDepth).toBe(MAX_DEPTH);
    expect(newChildDepth <= MAX_DEPTH).toBe(true);
  });
});

describe("sumTreeCost", () => {
  it("returns 0 for empty subtree", () => {
    expect(sumTreeCost([])).toBe(0);
  });

  it("treats null costs as 0", () => {
    expect(
      sumTreeCost([
        { totalCostUsd: null },
        { totalCostUsd: null },
      ])
    ).toBe(0);
  });

  it("sums numeric costs across all rows", () => {
    expect(
      sumTreeCost([
        { totalCostUsd: 0.1 },
        { totalCostUsd: 0.25 },
        { totalCostUsd: null },
        { totalCostUsd: 1.5 },
      ])
    ).toBeCloseTo(1.85, 6);
  });

  it("ignores non-finite costs", () => {
    expect(
      sumTreeCost([
        { totalCostUsd: 1.0 },
        { totalCostUsd: NaN },
        { totalCostUsd: Infinity },
      ])
    ).toBe(1.0);
  });
});

describe("checkTreeBudget", () => {
  it("returns null when the root has no budget cap", () => {
    expect(checkTreeBudget({ budgetMaxUsd: null }, 100)).toBeNull();
  });

  it("returns null when under cap", () => {
    // cap = 10 * 3 = 30
    expect(checkTreeBudget({ budgetMaxUsd: 10 }, 5)).toBeNull();
    expect(checkTreeBudget({ budgetMaxUsd: 10 }, 29.99)).toBeNull();
  });

  it("returns budget descriptor when spent meets/exceeds cap", () => {
    const r = checkTreeBudget({ budgetMaxUsd: 10 }, 30);
    expect(r).not.toBeNull();
    expect(r!.capUsd).toBe(30);
    expect(r!.spentUsd).toBe(30);

    const r2 = checkTreeBudget({ budgetMaxUsd: 10 }, 100);
    expect(r2).not.toBeNull();
    expect(r2!.spentUsd).toBe(100);
  });

  it("honours custom multiplier", () => {
    // cap = 10 * 5 = 50
    expect(checkTreeBudget({ budgetMaxUsd: 10 }, 49, 5)).toBeNull();
    expect(checkTreeBudget({ budgetMaxUsd: 10 }, 50, 5)).not.toBeNull();
  });

  it("default multiplier is 3", () => {
    expect(DEFAULT_TREE_BUDGET_MULT).toBe(3);
    const r = checkTreeBudget({ budgetMaxUsd: 2 }, 6);
    expect(r).not.toBeNull();
    expect(r!.capUsd).toBe(6);
  });
});

describe("integration: depth + budget on a fake parent chain", () => {
  // Simulate the exact decision logic the spawn_agent handler performs,
  // without involving the DB. We're testing the wiring of computeDepth + the
  // depth cap, and computeDepth + checkTreeBudget composing into an
  // admissible/inadmissible decision.

  function decide(
    parentChain: ReadonlyArray<{ parentRunId: number | null }>,
    root: { budgetMaxUsd: number | null },
    spent: number
  ): { ok: true } | { ok: false; reason: "depth" | "budget" } {
    const newChildDepth = computeDepth(parentChain) + 1;
    if (newChildDepth > MAX_DEPTH) return { ok: false, reason: "depth" };
    const overBudget = checkTreeBudget(root, spent);
    if (overBudget) return { ok: false, reason: "budget" };
    return { ok: true };
  }

  it("admits a root-level spawn", () => {
    expect(decide([], { budgetMaxUsd: 5 }, 0)).toEqual({ ok: true });
  });

  it("admits depth-3 spawn (child lands at MAX_DEPTH)", () => {
    expect(
      decide(
        [{ parentRunId: 1 }, { parentRunId: null }],
        { budgetMaxUsd: 100 },
        0
      )
    ).toEqual({ ok: true });
  });

  it("rejects depth-4 spawn (parent chain length already = MAX_DEPTH)", () => {
    expect(
      decide(
        [{ parentRunId: 2 }, { parentRunId: 1 }, { parentRunId: null }],
        { budgetMaxUsd: 100 },
        0
      )
    ).toEqual({ ok: false, reason: "depth" });
  });

  it("rejects when tree-budget cap is hit, even at admissible depth", () => {
    expect(
      decide([{ parentRunId: null }], { budgetMaxUsd: 10 }, 30)
    ).toEqual({ ok: false, reason: "budget" });
  });

  it("depth check fires before budget check (deeper-than-max rejected even with no budget cap)", () => {
    expect(
      decide(
        [{ parentRunId: 2 }, { parentRunId: 1 }, { parentRunId: null }],
        { budgetMaxUsd: null },
        0
      )
    ).toEqual({ ok: false, reason: "depth" });
  });
});

describe("checkAppendableStatus (append_message refusal predicate)", () => {
  it("refuses closed runs with a closed-specific message", () => {
    const msg = checkAppendableStatus("closed");
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/closed/i);
  });

  it("refuses other terminal statuses", () => {
    for (const s of ["completed", "failed", "cancelled", "budget_exhausted"]) {
      const msg = checkAppendableStatus(s);
      expect(msg, `status=${s}`).not.toBeNull();
      expect(msg, `status=${s}`).toMatch(new RegExp(s));
    }
  });

  it("admits idle and pending runs", () => {
    expect(checkAppendableStatus("idle")).toBeNull();
    expect(checkAppendableStatus("pending")).toBeNull();
  });

  it("admits in-flight statuses (runs.append guards the race separately)", () => {
    // append_message itself doesn't refuse these — runs.append() returns a
    // clear error if the target is already running. Keeping the predicate
    // narrow keeps refusal semantics ('this state is non-recoverable')
    // distinct from race semantics ('come back later').
    expect(checkAppendableStatus("running")).toBeNull();
    expect(checkAppendableStatus("preparing")).toBeNull();
    expect(checkAppendableStatus("pushing")).toBeNull();
  });
});

describe("append_message + tree-budget interaction", () => {
  // The append_message handler uses the same checkTreeBudget helper as
  // spawn_agent, with the caller's tree as the budget reference. Reuse the
  // existing pure-helper tests by composing them here in the shape the
  // handler runs them in.
  function decideAppend(
    callerRoot: { budgetMaxUsd: number | null },
    spent: number,
    targetStatus: string
  ): { ok: true } | { ok: false; reason: "budget" | "status" } {
    const overBudget = checkTreeBudget(callerRoot, spent);
    if (overBudget) return { ok: false, reason: "budget" };
    const refusal = checkAppendableStatus(targetStatus);
    if (refusal) return { ok: false, reason: "status" };
    return { ok: true };
  }

  it("admits an append on idle target with under-budget caller tree", () => {
    expect(decideAppend({ budgetMaxUsd: 10 }, 5, "idle")).toEqual({ ok: true });
  });

  it("admits append on idle target when caller has no budget cap", () => {
    expect(decideAppend({ budgetMaxUsd: null }, 999, "idle")).toEqual({ ok: true });
  });

  it("budget check fires before status check (over-budget rejected even with idle target)", () => {
    // cap = 10 * 3 = 30
    expect(decideAppend({ budgetMaxUsd: 10 }, 30, "idle")).toEqual({
      ok: false,
      reason: "budget",
    });
  });

  it("rejects closed target even when budget is fine", () => {
    expect(decideAppend({ budgetMaxUsd: 10 }, 0, "closed")).toEqual({
      ok: false,
      reason: "status",
    });
  });
});

describe("extractLatestAssistantText", () => {
  it("returns null for empty input", () => {
    expect(extractLatestAssistantText([])).toBeNull();
  });

  it("returns null when no agent rows are present", () => {
    expect(
      extractLatestAssistantText([
        { role: "user", content: JSON.stringify([{ type: "text", text: "hi" }]) },
        { role: "tool", content: JSON.stringify([{ type: "tool_result" }]) },
      ])
    ).toBeNull();
  });

  it("picks the last agent row's joined text blocks", () => {
    const rows = [
      { role: "agent", content: JSON.stringify([{ type: "text", text: "first" }]) },
      { role: "user", content: JSON.stringify([{ type: "text", text: "ignored" }]) },
      {
        role: "agent",
        content: JSON.stringify([
          { type: "text", text: "hello" },
          { type: "tool_use", id: "x" },
          { type: "text", text: "world" },
        ]),
      },
    ];
    expect(extractLatestAssistantText(rows)).toBe("hello\nworld");
  });

  it("skips agent rows with no text and falls back to an earlier one", () => {
    const rows = [
      { role: "agent", content: JSON.stringify([{ type: "text", text: "earlier" }]) },
      { role: "agent", content: JSON.stringify([{ type: "tool_use", id: "x" }]) },
    ];
    expect(extractLatestAssistantText(rows)).toBe("earlier");
  });

  it("tolerates invalid JSON by skipping the row", () => {
    const rows = [
      { role: "agent", content: JSON.stringify([{ type: "text", text: "ok" }]) },
      { role: "agent", content: "{not json" },
    ];
    expect(extractLatestAssistantText(rows)).toBe("ok");
  });

  it("ignores rows whose parsed content is not an array", () => {
    const rows = [
      { role: "agent", content: JSON.stringify({ type: "text", text: "object-not-array" }) },
      { role: "agent", content: JSON.stringify([{ type: "text", text: "good" }]) },
    ];
    expect(extractLatestAssistantText(rows)).toBe("good");
  });

  it("trims whitespace-only text rows out", () => {
    const rows = [
      { role: "agent", content: JSON.stringify([{ type: "text", text: "real" }]) },
      { role: "agent", content: JSON.stringify([{ type: "text", text: "   \n  " }]) },
    ];
    expect(extractLatestAssistantText(rows)).toBe("real");
  });
});
