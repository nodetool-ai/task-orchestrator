import { describe, expect, it } from "vitest";
import {
  computeDepth,
  sumTreeCost,
  checkTreeBudget,
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
