import { describe, expect, it } from "vitest";
import type { PlanSummary, TaskSummary } from "../../src/api/types.js";
import { buildPalette, filterPalette, type PaletteItem } from "../../src/model/palette.js";
import type { Run } from "../../src/model/run.js";

function run(id: number, persona: string, title: string): Run {
  return {
    id,
    parentId: null,
    persona,
    title,
    status: "running",
    taskId: null,
    planId: null,
    pr: null,
    startedAt: 0,
    completedAt: null,
    cost: 0,
    pendingEvents: 0,
    error: null,
  };
}
const task = (id: string, title: string): TaskSummary => ({ id, title, state: "todo", planId: "P-cli", prUrl: null });
const plan = (id: string, title: string): PlanSummary => ({ id, title, state: "accepted" });
const idsOf = (items: PaletteItem[]) => items.map((i) => i.id);

describe("buildPalette", () => {
  it("keys runs with #id and labels them persona · title", () => {
    const items = buildPalette([run(42, "concierge", "ship the CLI plan")], [task("T-0005", "CLI")], [plan("P-cli", "CLI")]);
    expect(items[0]).toEqual({ kind: "run", id: "#42", label: "concierge · ship the CLI plan", runId: 42 });
    expect(items.map((i) => i.kind)).toEqual(["run", "task", "plan"]);
  });
});

describe("filterPalette", () => {
  const items = buildPalette(
    [run(42, "concierge", "ship the CLI plan"), run(4, "qa", "flaky test triage"), run(142, "planner", "spec")],
    [task("T-0005", "CLI shares the repo layer"), task("T-0006", "chat + runs subcommands")],
    [plan("P-cli", "Task orchestrator CLI")]
  );

  it("returns the head of the list unfiltered for an empty query", () => {
    expect(filterPalette(items, "")).toEqual(items);
    expect(filterPalette(items, "   ", 2)).toEqual(items.slice(0, 2));
  });

  it("finds a run by its bare number", () => {
    expect(idsOf(filterPalette(items, "42"))[0]).toBe("#42");
  });

  it("ranks a prefix match on the id above a scattered match in a title", () => {
    // "t-0005" is a prefix of the task id; it is also a subsequence of no title.
    expect(idsOf(filterPalette(items, "t-000"))).toEqual(["T-0005", "T-0006"]);
    // "cli" hits the P-cli id (prefix-ish, word boundary) and two titles.
    const cli = idsOf(filterPalette(items, "cli"));
    expect(cli[0]).toBe("P-cli");
    expect(cli).toContain("T-0005");
    expect(cli.indexOf("P-cli")).toBeLessThan(cli.indexOf("T-0005"));
  });

  it("matches a real subsequence, not a substring", () => {
    // "srl" ⊂ "…Shares the Repo Layer" but is not a substring of anything.
    expect(idsOf(filterPalette(items, "srl"))).toContain("T-0005");
  });

  it("prefers the more contiguous match", () => {
    const ranked = idsOf(filterPalette(items, "chat"));
    expect(ranked[0]).toBe("T-0006"); // "chat + runs" beats any scattered hit
  });

  it("drops non-matches and honours the limit", () => {
    expect(filterPalette(items, "zzzz")).toEqual([]);
    expect(filterPalette(items, "c", 2)).toHaveLength(2);
  });
});
