import { describe, expect, it } from "vitest";
import type { RunIndexRow } from "../../src/api/types.js";
import { prNumber, toRun } from "../../src/model/run.js";

function row(over: Partial<RunIndexRow> = {}): RunIndexRow {
  return {
    id: 42,
    goal: "ship the CLI plan",
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
    budgetMaxUsd: null,
    budgetMaxTurns: null,
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

describe("toRun", () => {
  it("prefers title, then task title, then goal", () => {
    expect(toRun(row({ title: "t", taskTitle: "tt" })).title).toBe("t");
    expect(toRun(row({ taskTitle: "tt" })).title).toBe("tt");
    expect(toRun(row()).title).toBe("ship the CLI plan");
  });

  it("trims a multi-line goal to one line", () => {
    expect(toRun(row({ goal: "  fix   the thing\nand then some more\n" })).title).toBe("fix the thing");
  });

  it("falls back through personaName → personaId → agent", () => {
    expect(toRun(row({ personaName: "Concierge", personaId: "concierge" })).persona).toBe("Concierge");
    expect(toRun(row({ personaId: "concierge" })).persona).toBe("concierge");
    expect(toRun(row()).persona).toBe("agent");
  });

  it("defaults a null cost to zero and keeps epoch ms", () => {
    const r = toRun(row({ totalCostUsd: null, completedAt: "2026-08-22T10:30:00.000Z" }));
    expect(r.cost).toBe(0);
    expect(r.startedAt).toBe(Date.parse("2026-08-22T10:00:00.000Z"));
    expect(r.completedAt).toBe(Date.parse("2026-08-22T10:30:00.000Z"));
  });

  it("reports CI as unknown — the overview payload does not carry it", () => {
    expect(toRun(row({ prUrl: "https://github.com/o/r/pull/312" })).pr).toEqual({ number: 312, ci: "unknown" });
    expect(toRun(row()).pr).toBeNull();
  });
});

describe("prNumber", () => {
  it.each([
    ["https://github.com/nodetool-ai/task-orchestrator/pull/312", 312],
    ["https://github.com/o/r/pull/312/", 312],
    ["https://github.com/o/r/pull/312/files", 312],
    ["https://github.com/o/r/pull/312#issuecomment-9", 312],
    ["https://github.com/o/r/pull/312?w=1", 312],
    ["  https://github.com/o/r/pull/7  ", 7],
  ])("%s → %i", (url, n) => {
    expect(prNumber(url)).toBe(n);
  });

  it.each([
    null,
    "",
    "312",
    "not a url",
    "https://gitlab.com/o/r/merge_requests/12",
    "https://github.com/o/r/issues/312",
    "https://github.com/o/r/pull/abc",
    "https://github.com/o/r/pull/",
  ])("%s → null", (url) => {
    expect(prNumber(url as string | null)).toBeNull();
  });
});
