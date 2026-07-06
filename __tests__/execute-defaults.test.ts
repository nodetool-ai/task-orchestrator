// Plan executor (goal=<execute>) now runs cwd_strategy="none" by default: it
// holds no repo checkout, mounts no fs/shell tools, and inspects PRs purely
// through gh_pr__pr_view/pr_diff (GitHub API), delegating code-level
// investigation to child runs. This locks in the defaulting behavior in
// lib/runs.ts create(), and confirms an explicit override still wins.
import { describe, expect, it } from "vitest";
import * as repo from "../lib/repo";
import { create, get } from "../lib/runs";

describe("create({ goal: '<execute>' }) cwd/tools defaults", () => {
  it("defaults to cwd_strategy=none and the repo-less tools profile", async () => {
    const plan = await repo.createPlan({ title: "Defaults", date: "2026-07-06" });
    const run = await create({ goal: "<execute>", planId: plan.id, defer: true });

    expect(run.cwdStrategy).toBe("none");
    expect(run.toolsProfile).toBe("orchestrator,gh_pr,spawn");

    const reloaded = await get(run.id);
    expect(reloaded?.cwdStrategy).toBe("none");
    expect(reloaded?.toolsProfile).toBe("orchestrator,gh_pr,spawn");
  });

  it("still honors an explicit cwdStrategy/toolsProfile override", async () => {
    const plan = await repo.createPlan({ title: "Override", date: "2026-07-06" });
    const run = await create({
      goal: "<execute>",
      planId: plan.id,
      defer: true,
      cwdStrategy: "worktree",
      toolsProfile: "orchestrator,repo_write",
    });

    expect(run.cwdStrategy).toBe("worktree");
    expect(run.toolsProfile).toBe("orchestrator,repo_write");
  });
});
