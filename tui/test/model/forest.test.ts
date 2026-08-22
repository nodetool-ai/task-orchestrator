import { describe, expect, it } from "vitest";
import type { RunIndexRow } from "../../src/api/types.js";
import { buildForest, flatten, flattenFrom, floorGroups } from "../../src/model/forest.js";
// Local fixture: importing another .test.ts would re-register its suites here.
function r(over: Partial<RunIndexRow>): RunIndexRow {
  return {
    id: 1,
    goal: "goal",
    status: "running",
    origin: "chat",
    title: null,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    totalCostUsd: null,
    error: null,
    startedAt: "2026-08-22T10:00:00.000Z",
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    personaId: null,
    personaName: null,
    ...over,
  };
}
const ids = (rows: Array<{ run: { id: number } }>) => rows.map((x) => x.run.id);

describe("buildForest", () => {
  it("indexes children and roots in row order", () => {
    const f = buildForest([
      r({ id: 42 }),
      r({ id: 43, parentRunId: 42 }),
      r({ id: 44, parentRunId: 43 }),
      r({ id: 40 }),
    ]);
    expect(f.roots().map((x) => x.id)).toEqual([42, 40]);
    expect(f.childrenOf(42).map((x) => x.id)).toEqual([43]);
    expect(f.childrenOf(44)).toEqual([]);
    expect(f.byId(44)?.id).toBe(44);
    expect(f.byId(999)).toBeUndefined();
  });

  it("keeps a run whose parent is not in the snapshot, as a root", () => {
    const f = buildForest([r({ id: 44, parentRunId: 43 })]);
    expect(f.roots().map((x) => x.id)).toEqual([44]);
    expect(ids(flatten(f))).toEqual([44]);
  });

  it("handles a parent that appears after its child", () => {
    const f = buildForest([r({ id: 44, parentRunId: 43 }), r({ id: 43 })]);
    expect(f.roots().map((x) => x.id)).toEqual([43]);
    expect(ids(flatten(f))).toEqual([43, 44]);
  });

  it("survives a parent cycle without hanging", () => {
    const f = buildForest([
      r({ id: 1, parentRunId: 2 }),
      r({ id: 2, parentRunId: 1 }),
      r({ id: 3, parentRunId: 3 }),
    ]);
    // Every run is still reachable, and nothing loops.
    expect(ids(flatten(f)).sort()).toEqual([1, 2, 3]);
    expect(f.subtreeCost(1)).toBe(0);
    expect(f.ancestors(1).map((x) => x.id)).not.toContain(1);
    expect(floorGroups(f).live.length + floorGroups(f).rest.length).toBe(3);
  });

  it("sums a multi-level subtree cost", () => {
    const f = buildForest([
      r({ id: 42, totalCostUsd: 1.2 }),
      r({ id: 43, parentRunId: 42, totalCostUsd: 0.31 }),
      r({ id: 44, parentRunId: 43, totalCostUsd: 0.42 }),
      r({ id: 45, parentRunId: 43, totalCostUsd: 0.11 }),
      r({ id: 40, totalCostUsd: 5 }),
    ]);
    expect(f.subtreeCost(44)).toBeCloseTo(0.42);
    expect(f.subtreeCost(43)).toBeCloseTo(0.84);
    expect(f.subtreeCost(42)).toBeCloseTo(2.04);
    expect(f.subtreeCost(40)).toBeCloseTo(5);
    expect(f.subtreeOf(43).map((x) => x.id)).toEqual([43, 44, 45]);
  });

  it("lists ancestors nearest-parent-first", () => {
    const f = buildForest([r({ id: 42 }), r({ id: 43, parentRunId: 42 }), r({ id: 44, parentRunId: 43 })]);
    expect(f.ancestors(44).map((x) => x.id)).toEqual([43, 42]);
    expect(f.ancestors(42)).toEqual([]);
  });

  it("counts only actually-working runs as live", () => {
    const f = buildForest([
      r({ id: 1, status: "running" }),
      r({ id: 2, status: "preparing" }),
      r({ id: 3, status: "pending" }),
      r({ id: 4, status: "completed" }),
    ]);
    expect(f.liveCount()).toBe(2);
  });
});

describe("flatten", () => {
  it("draws the ├ └ │ prefixes of the mockup", () => {
    const f = buildForest([
      r({ id: 42 }),
      r({ id: 43, parentRunId: 42 }),
      r({ id: 44, parentRunId: 43 }),
      r({ id: 45, parentRunId: 43 }),
    ]);
    expect(flatten(f).map((x) => `${x.prefix}#${x.run.id}`)).toEqual(["#42", "└ #43", "  ├ #44", "  └ #45"]);
  });

  it("flattenFrom walks an explicit set of tops", () => {
    const f = buildForest([r({ id: 42 }), r({ id: 43, parentRunId: 42 }), r({ id: 44, parentRunId: 43 })]);
    expect(ids(flattenFrom(f, [f.byId(43)!]))).toEqual([43, 44]);
  });
});

describe("floorGroups", () => {
  it("puts live subtrees first and keeps children under their parent", () => {
    const f = buildForest([
      // A finished root whose child is still working: stays on the live floor.
      r({ id: 40, status: "completed" }),
      r({ id: 41, parentRunId: 40, status: "running" }),
      // Wholly finished.
      r({ id: 36, status: "failed" }),
      r({ id: 37, parentRunId: 36, status: "completed" }),
      // Live root.
      r({ id: 42, status: "running" }),
      r({ id: 43, parentRunId: 42, status: "parked", parkReason: "question" }),
    ]);
    const { live, rest } = floorGroups(f);
    expect(ids(live)).toEqual([40, 41, 42, 43]);
    expect(ids(rest)).toEqual([36, 37]);
    expect(live.map((x) => x.depth)).toEqual([0, 1, 0, 1]);
  });

  it("does not promote a dead root just because a sibling tree is live", () => {
    const f = buildForest([r({ id: 1, status: "completed" }), r({ id: 2, status: "running" })]);
    expect(ids(floorGroups(f).live)).toEqual([2]);
    expect(ids(floorGroups(f).rest)).toEqual([1]);
  });
});
