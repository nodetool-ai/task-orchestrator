// __tests__/profiles.test.ts
//
// Unit tests for lib/profiles.ts profile resolution, focused on the
// gh_pr / gh_pr_ro split: a review run (untrusted third-party PR) must be
// mountable with a tool set that has no pr_merge and no approving pr_review,
// while the pre-existing gh_pr profile (implementor/executor runs that
// legitimately manage their own PR) must stay exactly as it was.

import { describe, expect, it } from "vitest";
import { listProfiles, resolveProfiles } from "../lib/profiles";
import { makeRegistrar } from "./helpers/fake-registrar";
import type { RunRow } from "../lib/runs";

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    goal: "<review>",
    status: "idle",
    origin: "task",
    taskId: null,
    planId: null,
    repoId: null,
    parentRunId: null,
    toolsProfile: "orchestrator,repo_read,gh_pr_ro",
    cwdStrategy: "worktree_at_pr",
    model: null,
    thinkingLevel: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    error: null,
    outcome: null,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    sdkSessionId: null,
    budgetMaxTurns: null,
    budgetMaxUsd: null,
    budgetMaxSeconds: null,
    userId: null,
    title: null,
    personaId: "reviewer",
    legacyChatId: null,
    planningStage: null,
    startedAt: new Date(),
    completedAt: null,
    heartbeatAt: null,
    workerScope: null,
    workerPid: null,
    cancelRequested: null,
    attempt: 1,
    result: null,
    parkReason: null,
    ...overrides,
  };
}

const baseCtx = {
  runId: 1,
  run: makeRun(),
  author: "test",
  taskId: null,
  planId: null,
  cwd: "/tmp",
};

describe("listProfiles", () => {
  it("includes the new gh_pr_ro profile alongside the untouched gh_pr", () => {
    const names = listProfiles();
    expect(names).toContain("gh_pr");
    expect(names).toContain("gh_pr_ro");
  });
});

describe("resolveProfiles('gh_pr_ro', ...)", () => {
  it("mounts a tool set with no pr_merge and no approving pr_review", async () => {
    const resolved = await resolveProfiles("gh_pr_ro", baseCtx);
    expect(resolved.factories.length).toBe(1);

    const r = makeRegistrar();
    await resolved.factories[0](r.reg);

    expect(r.tools.has("gh_pr__pr_merge")).toBe(false);
    expect(r.tools.has("gh_pr__pr_view")).toBe(true);
    expect(r.tools.has("gh_pr__pr_diff")).toBe(true);
    expect(r.tools.has("gh_pr__pr_comment")).toBe(true);

    const review = r.tools.get("gh_pr__pr_review");
    expect(review).toBeDefined();
    const verdictSchema: any = (review!.parameters as any).properties.verdict;
    const literals = (verdictSchema.anyOf ?? [verdictSchema]).map((s: any) => s.const);
    expect(literals).not.toContain("approve");
    expect(literals).toEqual(expect.arrayContaining(["comment", "request_changes"]));
  });

  it("does not grant repo write access", async () => {
    const resolved = await resolveProfiles("repo_read,gh_pr_ro", baseCtx);
    expect(resolved.allowsRepoWrite).toBe(false);
  });
});

describe("resolveProfiles('gh_pr', ...) stays exactly as it was", () => {
  it("mounts the full tool set including pr_merge and an approving pr_review", async () => {
    const resolved = await resolveProfiles("gh_pr", baseCtx);
    expect(resolved.factories.length).toBe(1);

    const r = makeRegistrar();
    await resolved.factories[0](r.reg);

    expect(r.tools.has("gh_pr__pr_merge")).toBe(true);
    const review = r.tools.get("gh_pr__pr_review");
    expect(review).toBeDefined();
    const verdictSchema: any = (review!.parameters as any).properties.verdict;
    const literals = (verdictSchema.anyOf ?? [verdictSchema]).map((s: any) => s.const);
    expect(literals).toContain("approve");
  });
});

describe("resolveProfiles unknown profile", () => {
  it("throws", async () => {
    await expect(resolveProfiles("nonexistent_profile", baseCtx)).rejects.toThrow(
      "Unknown tools profile"
    );
  });
});
