import { describe, expect, it } from "vitest";
import { parseMergeability } from "../lib/gh-merge";
import { buildMergePrompt } from "../lib/run-templates";
import { isResumableRun, isResumableWorktreeRun } from "../lib/runs";

describe("parseMergeability", () => {
  it("maps a CONFLICTING PR with its base ref", () => {
    expect(
      parseMergeability(JSON.stringify({ mergeable: "CONFLICTING", baseRefName: "main" }))
    ).toEqual({ mergeable: "CONFLICTING", baseRef: "main" });
  });

  it("maps a clean PR", () => {
    expect(
      parseMergeability(JSON.stringify({ mergeable: "MERGEABLE", baseRefName: "develop" }))
    ).toEqual({ mergeable: "MERGEABLE", baseRef: "develop" });
  });

  it("normalises case and unknown values to UNKNOWN", () => {
    expect(parseMergeability(JSON.stringify({ mergeable: "unknown", baseRefName: "x" }))).toEqual({
      mergeable: "UNKNOWN",
      baseRef: "x",
    });
    expect(parseMergeability(JSON.stringify({ mergeable: "WAT", baseRefName: "x" })).mergeable).toBe(
      "UNKNOWN"
    );
  });

  it("fails closed (UNKNOWN, null base) on invalid JSON or wrong shape", () => {
    expect(parseMergeability("{not json")).toEqual({ mergeable: "UNKNOWN", baseRef: null });
    expect(parseMergeability("[]")).toEqual({ mergeable: "UNKNOWN", baseRef: null });
    expect(parseMergeability(JSON.stringify({ baseRefName: "" }))).toEqual({
      mergeable: "UNKNOWN",
      baseRef: null,
    });
  });
});

describe("buildMergePrompt", () => {
  it("names the base ref and forbids opening a new PR", () => {
    const p = buildMergePrompt("release-2.0");
    expect(p).toContain("release-2.0");
    expect(p).toContain("git fetch origin release-2.0");
    expect(p).toMatch(/do not open a new pr/i);
  });

  it("falls back to main when the base ref is null/blank", () => {
    expect(buildMergePrompt(null)).toContain("`main`");
    expect(buildMergePrompt("   ")).toContain("`main`");
  });
});

describe("isResumableWorktreeRun", () => {
  it("resumes finished worktree sessions (the attached run after a turn)", () => {
    for (const s of ["idle", "completed", "failed", "budget_exhausted"]) {
      expect(isResumableWorktreeRun(s, "worktree"), s).toBe(true);
    }
  });

  it("never resumes closed or in-flight worktree runs", () => {
    for (const s of ["closed", "running", "preparing", "pushing", "opening_pr"]) {
      expect(isResumableWorktreeRun(s, "worktree"), s).toBe(false);
    }
  });

  it("is false for non-worktree runs (chat/none/review keep idle-only resume)", () => {
    expect(isResumableWorktreeRun("completed", "none")).toBe(false);
    expect(isResumableWorktreeRun("completed", "repo")).toBe(false);
    expect(isResumableWorktreeRun("completed", "worktree_at_pr")).toBe(false);
  });
});

describe("isResumableRun", () => {
  const executor = { goal: "<execute>", cwdStrategy: "repo", planId: "P-1" };

  it("resumes a terminal plan executor (state is durable Postgres rows, not a worktree)", () => {
    for (const status of ["idle", "completed", "failed", "budget_exhausted"]) {
      expect(isResumableRun({ ...executor, status }), status).toBe(true);
    }
  });

  it("never resumes a cancelled/closed or in-flight executor", () => {
    for (const status of ["cancelled", "closed", "running", "preparing", "pending", "parked"]) {
      expect(isResumableRun({ ...executor, status }), status).toBe(false);
    }
  });

  it("requires a planId on the executor", () => {
    expect(isResumableRun({ ...executor, status: "failed", planId: null })).toBe(false);
  });

  it("keeps the worktree rule for non-executor runs", () => {
    expect(
      isResumableRun({ goal: "<implement>", cwdStrategy: "worktree", planId: null, status: "failed" })
    ).toBe(true);
    expect(
      isResumableRun({ goal: "<chat>", cwdStrategy: "none", planId: null, status: "failed" })
    ).toBe(false);
    expect(
      isResumableRun({ goal: "<review>", cwdStrategy: "worktree_at_pr", planId: null, status: "failed" })
    ).toBe(false);
  });
});
