// Pure helpers behind the unified /runs index: forest building from
// parent_run_id, tree-level status grouping, filtering, and display labels.
import { describe, expect, it } from "vitest";

import {
  buildRunForest,
  filterForest,
  groupForStatus,
  groupForTree,
  kindForRun,
  latestActivity,
  runGoalTag,
  runHeading,
  treeSize,
  type RunIndexRow,
} from "@/lib/run-index";

function row(overrides: Partial<RunIndexRow> & { id: number }): RunIndexRow {
  return {
    goal: "<chat>",
    status: "idle",
    origin: "chat",
    title: null,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    personaId: null,
    personaName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    budgetMaxUsd: null,
    budgetMaxTurns: null,
    totalCostUsd: null,
    error: null,
    startedAt: "2026-07-01T10:00:00.000Z",
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    ...overrides,
  };
}

describe("buildRunForest", () => {
  it("nests children under their parents in id order", () => {
    const forest = buildRunForest([
      row({ id: 1 }),
      row({ id: 3, parentRunId: 1 }),
      row({ id: 2, parentRunId: 1 }),
      row({ id: 4, parentRunId: 2 }),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0].run.id).toBe(1);
    expect(forest[0].children.map((c) => c.run.id)).toEqual([2, 3]);
    expect(forest[0].children[0].children.map((c) => c.run.id)).toEqual([4]);
    expect(treeSize(forest[0])).toBe(4);
  });

  it("keeps the caller's root order (startedAt desc from the DB)", () => {
    const forest = buildRunForest([row({ id: 9 }), row({ id: 5 }), row({ id: 7 })]);
    expect(forest.map((t) => t.run.id)).toEqual([9, 5, 7]);
  });

  it("promotes a child whose parent row is missing to a root", () => {
    const forest = buildRunForest([row({ id: 2, parentRunId: 99 }), row({ id: 1 })]);
    expect(forest.map((t) => t.run.id).sort()).toEqual([1, 2]);
  });

  it("survives self-references and parent cycles without losing runs", () => {
    const forest = buildRunForest([
      row({ id: 1, parentRunId: 1 }), // self-reference
      row({ id: 2, parentRunId: 3 }), // 2 ⇄ 3 cycle
      row({ id: 3, parentRunId: 2 }),
    ]);
    const seen = new Set<number>();
    const walk = (nodes: typeof forest) => {
      for (const n of nodes) {
        seen.add(n.run.id);
        walk(n.children);
      }
    };
    walk(forest);
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
});

describe("groupForTree", () => {
  it("uses the root's own group for a leaf", () => {
    expect(groupForTree(buildRunForest([row({ id: 1, status: "completed" })])[0])).toBe(
      "closed"
    );
  });

  it("bubbles a live child up: a finished parent with a running child is active", () => {
    const forest = buildRunForest([
      row({ id: 1, status: "completed" }),
      row({ id: 2, status: "running", parentRunId: 1 }),
    ]);
    expect(groupForTree(forest[0])).toBe("active");
  });

  it("ranks idle above closed", () => {
    const forest = buildRunForest([
      row({ id: 1, status: "failed" }),
      row({ id: 2, status: "pending", parentRunId: 1 }),
    ]);
    expect(groupForTree(forest[0])).toBe("idle");
  });

  it("groups unknown statuses as idle so they stay discoverable", () => {
    expect(groupForStatus("someday-status")).toBe("idle");
  });
});

describe("latestActivity", () => {
  it("takes the newest startedAt anywhere in the tree", () => {
    const forest = buildRunForest([
      row({ id: 1, startedAt: "2026-07-01T10:00:00.000Z" }),
      row({ id: 2, parentRunId: 1, startedAt: "2026-07-03T10:00:00.000Z" }),
    ]);
    expect(latestActivity(forest[0])).toBe(Date.parse("2026-07-03T10:00:00.000Z"));
  });
});

describe("filterForest", () => {
  const forest = buildRunForest([
    row({ id: 1, goal: "<execute>", origin: "task", repoId: "r1" }),
    row({ id: 2, goal: "<implement>", origin: "task", parentRunId: 1, taskId: "T-1", repoId: "r2" }),
    row({ id: 3, goal: "<chat>", repoId: "r3" }),
  ]);

  it("filters roots by kind", () => {
    expect(filterForest(forest, { kind: "chat" }).map((t) => t.run.id)).toEqual([3]);
    expect(filterForest(forest, { kind: "agent" }).map((t) => t.run.id)).toEqual([1]);
  });

  it("keeps a whole tree when ANY member matches repo/task", () => {
    expect(filterForest(forest, { repoId: "r2" }).map((t) => t.run.id)).toEqual([1]);
    expect(filterForest(forest, { taskId: "T-1" }).map((t) => t.run.id)).toEqual([1]);
    expect(filterForest(forest, { taskId: "T-404" })).toEqual([]);
  });
});

describe("display helpers", () => {
  it("labels chats by title with an id fallback", () => {
    expect(runHeading(row({ id: 7, title: "Debug the reaper" }))).toBe("Debug the reaper");
    expect(runHeading(row({ id: 7 }))).toBe("Chat #7");
  });

  it("labels task runs by task title, then task id", () => {
    expect(
      runHeading(row({ id: 7, goal: "<implement>", taskId: "T-1", taskTitle: "Ship it" }))
    ).toBe("Ship it");
    expect(runHeading(row({ id: 7, goal: "<implement>", taskId: "T-1" }))).toBe("T-1");
  });

  it("labels executors by plan and free-form goals by the goal text", () => {
    expect(runHeading(row({ id: 7, goal: "<execute>", planTitle: "Q3 board" }))).toBe(
      "Execute: Q3 board"
    );
    expect(runHeading(row({ id: 7, goal: "summarize failures" }))).toBe("summarize failures");
    expect(runHeading(row({ id: 7, goal: "<implement>" }))).toBe("Run #7");
  });

  it("classifies kinds and goal tags", () => {
    expect(kindForRun({ goal: "<chat>" })).toBe("chat");
    expect(kindForRun({ goal: "<implement>" })).toBe("agent");
    expect(runGoalTag({ goal: "<review>" })).toBe("review");
    expect(runGoalTag({ goal: "<chat>" })).toBeNull();
  });
});
