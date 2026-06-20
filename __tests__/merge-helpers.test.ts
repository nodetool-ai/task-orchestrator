import { describe, expect, it } from "vitest";
import { parseMergeability } from "../lib/gh-merge";
import { buildMergePrompt } from "../lib/run-templates";
import { isResumableWorktreeRun } from "../lib/runs";

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
