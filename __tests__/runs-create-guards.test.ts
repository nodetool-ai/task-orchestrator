// __tests__/runs-create-guards.test.ts
//
// create() must validate the worktree invariants BEFORE inserting the row.
// Validating after the insert (the old behaviour) still returned the intended
// 400, but left behind a 'pending' agent_runs row that nothing ever drives —
// kickoff never started, and neither orphan reaper covers a taskless 'pending'
// run. The ghost then showed up permanently in the /runs UI "Idle" group.
//
// It is also the single admission point for implement-style task runs: ONE
// active agent per task (advisory-locked check-then-insert → 409), and ONE
// canonical branch per task (reserved on tasks.branch at create time, adopting
// a legacy attached-run branch when one exists).

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, plans, tasks } from "../db/schema";
import { create, list, taskBranchName } from "../lib/runs";
import * as repo from "../lib/repo";
import { seedPersonas } from "../db/seed-personas";

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

let seq = 0;
async function makeTask(): Promise<string> {
  const plan = await repo.createPlan({ title: `Plan ${++seq}`, date: "2026-07-10" });
  return (await repo.createTask({ planId: plan.id, title: `Task ${seq}`, date: "2026-07-10" })).id;
}

async function taskBranchOf(taskId: string): Promise<string | null> {
  const row = (
    await db.select({ branch: tasks.branch }).from(tasks).where(eq(tasks.id, taskId))
  )[0];
  return row?.branch ?? null;
}

describe("create() worktree invariant guards", () => {
  it("rejects a worktree run with no taskId and leaves NO row behind", async () => {
    await expect(
      create({ goal: "<implement>", cwdStrategy: "worktree" })
    ).rejects.toThrow(/taskId/);
    // The invariant is checked before db.insert, so no ghost 'pending' run.
    expect((await list()).length).toBe(0);
  });

  it("rejects a worktree_at_pr run with no prUrl and leaves NO row behind", async () => {
    await expect(
      create({ goal: "<review>", cwdStrategy: "worktree_at_pr", taskId: null })
    ).rejects.toThrow(/prUrl/);
    expect((await list()).length).toBe(0);
  });

  it("still creates a row for a deferred worktree run without a taskId", async () => {
    // defer skips the kickoff (and thus the invariant), matching the chat-box /
    // bare-test path — the row is intentionally allowed.
    const run = await create({ goal: "<implement>", cwdStrategy: "worktree", defer: true });
    expect(run.status).toBe("idle");
    expect((await list()).length).toBe(1);
  });
});

describe("create() one-active-agent-per-task admission", () => {
  it("refuses a second implement run while the first is active", async () => {
    const taskId = await makeTask();
    const first = await create({
      goal: "<implement>",
      cwdStrategy: "worktree",
      taskId,
      defer: true, // idle = active (non-terminal); no kickoff in tests
    });
    await expect(
      create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true })
    ).rejects.toThrow(new RegExp(`already has an active session \\(#${first.id}\\)`));
    // The loser must not leave a second row behind.
    expect((await list({ taskId })).length).toBe(1);
  });

  it("admits a follow-up run once the previous one is terminal", async () => {
    const taskId = await makeTask();
    const first = await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    await db
      .update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.id, first.id));
    const second = await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    expect(second.id).not.toBe(first.id);
  });

  it("does not block chat runs or review (worktree_at_pr) runs on the task", async () => {
    const taskId = await makeTask();
    await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    // Review runs use a throwaway checkout at the PR head — no branch conflict.
    const review = await create({
      goal: "<review>",
      cwdStrategy: "worktree_at_pr",
      taskId,
      prUrl: "https://github.com/o/r/pull/1",
      defer: true,
    });
    expect(review.id).toBeGreaterThan(0);
    // Plain chats never touch the task branch either.
    const chat = await create({ goal: "<chat>", taskId, defer: true });
    expect(chat.id).toBeGreaterThan(0);
  });
});

describe("create() task-branch reservation", () => {
  it("reserves claude/<taskid> on the first implement run and keeps it", async () => {
    const taskId = await makeTask();
    expect(await taskBranchOf(taskId)).toBeNull();
    const first = await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    expect(await taskBranchOf(taskId)).toBe(taskBranchName(taskId));
    // A later run reuses the same reservation — one branch per task, forever.
    await db
      .update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.id, first.id));
    await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    expect(await taskBranchOf(taskId)).toBe(taskBranchName(taskId));
  });

  it("adopts a legacy attached run's per-run branch for continuity", async () => {
    const taskId = await makeTask();
    // A pre-migration attached run with an old-style claude/<task>-<run> branch.
    const legacy = (
      await db
        .insert(agentSessions)
        .values({
          goal: "<implement>",
          cwdStrategy: "worktree",
          taskId,
          status: "completed",
          personaId: "implementor",
          branch: `claude/${taskId.toLowerCase()}-9999`,
        })
        .returning()
    )[0];
    await repo.attachRunToTask(taskId, legacy.id);
    await create({ goal: "<implement>", cwdStrategy: "worktree", taskId, defer: true });
    // The reservation keeps the legacy branch (its pushed commits / open PR
    // stay reachable) instead of minting a fresh claude/<taskid>.
    expect(await taskBranchOf(taskId)).toBe(`claude/${taskId.toLowerCase()}-9999`);
  });
});
