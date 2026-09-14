// __tests__/profiles.test.ts
//
// Unit tests for lib/profiles.ts profile resolution, focused on the
// gh_pr / gh_pr_ro split: a review run (untrusted third-party PR) must be
// mountable with a tool set that has no pr_merge and no approving pr_review,
// while the pre-existing gh_pr profile (implementor/executor runs that
// legitimately manage their own PR) must stay exactly as it was.

import { effectiveRunToolsProfile, planExecutorTurnPrompt } from "../lib/plan-executor-policy";
import { allowedServerTools } from "../lib/worker/server-policy";
import { describe, expect, it } from "vitest";
import { alwaysOnExtensions, listProfiles, resolveProfiles } from "../lib/profiles";
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
    backend: null,
    toolsProfile: "orchestrator,repo_read,gh_pr_ro",
    cwdStrategy: "worktree_at_pr",
    runtime: "worker",
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
    workerScope: null,
    pendingSince: null,
    claimedAt: null,
    cancelRequested: null,
    attempt: 1,
    result: null,
    parkReason: null,
    pendingReason: null,
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

describe("alwaysOnExtensions", () => {
  it("mounts event tools and Brave Search for every agent run", async () => {
    const factories = await alwaysOnExtensions(baseCtx);
    const r = makeRegistrar();
    for (const factory of factories) await factory(r.reg);

    expect(r.tools.has("timer__sleep")).toBe(true);
    expect(r.tools.has("brave__web_search")).toBe(true);
  });
});


describe("effective executor profile", () => {
  it("upgrades an old worker coordinator profile consistently for native and server tools", async () => {
    const run = makeRun({ personaId: "executor", toolsProfile: "orchestrator,spawn" });
    const profile = effectiveRunToolsProfile(run);
    const resolved = await resolveProfiles(profile, { ...baseCtx, run, repoRemote: null });
    expect(resolved.allowsRepoWrite).toBe(true);
    const r = makeRegistrar();
    for (const factory of resolved.factories) await factory(r.reg);
    expect(r.tools.has("gh_pr__pr_merge")).toBe(true);
    expect(r.tools.has("spawn__spawn_agent")).toBe(false);
    expect(await allowedServerTools(profile)).not.toContain("spawn__spawn_agent");
  });

  it("never adds filesystem capabilities to a retained server persona", () => {
    const run = makeRun({ personaId: "executor", runtime: "server", toolsProfile: "orchestrator,spawn" });
    expect(effectiveRunToolsProfile(run)).toBe("orchestrator,spawn");
    expect(planExecutorTurnPrompt(run, "continue")).toBe("continue");
  });

  it("reminds resumed executor threads without replaying the full persona", () => {
    const prompt = planExecutorTurnPrompt(makeRun({ goal: "<execute>" }), "Operator follow-up");
    expect(prompt).toContain("overriding older coordination-only instructions");
    expect(prompt).toContain("one active sub-agent");
    expect(prompt).toContain("Serialize heavy checks");
    expect(prompt.endsWith("Operator follow-up")).toBe(true);
    expect(planExecutorTurnPrompt(makeRun(), "review")).toBe("review");
  });
});
