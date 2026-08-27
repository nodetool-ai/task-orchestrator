// __tests__/agent-reaper.test.ts
//
// Tests for the orphan reaper in lib/agent.ts. The reaper runs on module
// import in every process sharing the DB and must not aggressively reap
// valid pending runs. Pending rows are the dispatch queue and remain young
// until actually dispatched; only stale ones (older than a grace period)
// indicate their owning process died before dispatch.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, tasks, plans } from "../db/schema";
import { _reapOrphansForTest, startSession } from "../lib/agent";
import { create, get } from "../lib/runs";
import * as runs from "../lib/runs";
import * as repo from "../lib/repo";
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";

const YOUNG = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
const OLD = new Date(Date.now() - 20 * 60_000); // 20 minutes ago (beyond 15 min grace)

beforeEach(async () => {
  installFakeRunnerProvider();
  // Clear agent sessions, tasks, and plans before each test
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function createTestTask(): Promise<string> {
  const plan = await repo.createPlan({
    title: "Test Plan",
    body: "Test plan for agent-reaper tests",
  });
  const task = await repo.createTask({ planId: plan.id, title: "Test Task" });
  return task.id;
}

describe("reapOrphans (orphan reaper in lib/agent.ts)", () => {
  it("spares a young pending implement run without a live lease", async () => {
    // A fresh pending run is the dispatch queue — owned by the creating
    // process or the detached pump. It should NOT be reaped even though
    // there's no lease (pending is not a lease status).
    const taskId = await createTestTask();
    const run = await create({
      goal: "<implement>",
      defer: true,
      taskId,
    });
    await db
      .update(agentSessions)
      .set({ status: "pending", startedAt: YOUNG})
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("pending");
    expect(after?.error).toBeNull();
  });

  it("reaps an old pending implement run without a live lease", async () => {
    // An old pending run indicates its owning process died before dispatch.
    // After the grace period, it is safe to assume the process is gone.
    const taskId = await createTestTask();
    const run = await create({
      goal: "<implement>",
      defer: true,
      taskId,
    });
    await db
      .update(agentSessions)
      .set({ status: "pending", startedAt: OLD})
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/[Oo]rphaned/);
    expect(after?.completedAt).not.toBeNull();
  });

  it("reaps a stale-heartbeat preparing run (no grace period for lease statuses)", async () => {
    // Non-pending lease statuses (preparing, running, pushing, opening_pr)
    // are not part of the dispatch queue — they indicate mid-turn activity.
    // Stale heartbeat means the owner crashed mid-turn; reap immediately.
    const taskId = await createTestTask();
    const run = await create({
      goal: "<implement>",
      defer: true,
      taskId,
    });
    const STALE = new Date(Date.now() - 10 * 60_000); // 10 min ago
    await db
      .update(agentSessions)
      .set({ status: "preparing", startedAt: YOUNG})
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/[Oo]rphaned/);
  });

  it("spares a preparing run observed alive in another process", async () => {
    // A preparing run with a fresh heartbeat is mid-turn in another process.
    // The reaper must never touch it.
    const taskId = await createTestTask();
    const run = await create({
      goal: "<implement>",
      defer: true,
      taskId,
    });
    const FRESH = new Date(Date.now() - 5_000); // 5 seconds ago
    await db
      .update(agentSessions)
      .set({ status: "preparing", startedAt: YOUNG})
      .where(eq(agentSessions.id, run.id));
    await setFakeRunLiveness(run.id, { status: "alive", incarnation: "fake-incarnation" });

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("preparing");
    expect(after?.error).toBeNull();
  });

  it("ignores chat runs (only implement runs are reaped)", async () => {
    // The reaper only targets implement runs. Chat runs are left alone.
    const run = await create({ goal: "<chat>", defer: true });
    const STALE = new Date(Date.now() - 30 * 60_000);
    await db
      .update(agentSessions)
      .set({ status: "pending", startedAt: STALE})
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("pending");
    expect(after?.error).toBeNull();
  });
});

describe("startSession concurrency (M17c)", () => {
  // startSession's duplicate-active-session guard used to be a plain
  // check-then-insert (listActiveSessions(taskId), then several awaits,
  // then runs.create) — two concurrent start_session calls for the same
  // task could both observe zero active sessions and both create a run.
  // Fixed with a Postgres transaction-scoped advisory lock (keyed on the
  // task id) around the check+create critical section in lib/agent.ts.
  //
  // runs.create's real implement-run path kicks off a worktree/SDK/gh
  // lifecycle (lib/runs.ts's kickoffFirstTurn / dispatchRun) that this test
  // must not trigger. Mirroring how agent-reaper.test.ts above and
  // dispatch-routing.test.ts avoid those side effects, we spy on runs.create
  // and force `defer: true` through to the real implementation: this still
  // exercises the real DB insert (and thus the real race on the advisory
  // lock + listActiveSessions re-check) without spawning a worker.
  const realCreate = runs.create;

  beforeEach(() => {
    vi.spyOn(runs, "create").mockImplementation((input) =>
      realCreate({ ...input, defer: true })
    );
  });

  async function createTestTaskForRace(): Promise<string> {
    const plan = await repo.createPlan({
      title: "Race Plan",
      body: "Test plan for startSession race tests",
    });
    const task = await repo.createTask({ planId: plan.id, title: "Race Task" });
    return task.id;
  }

  it("two concurrent startSession calls for one task: exactly one creates a run, the other gets a 409", async () => {
    const taskId = await createTestTaskForRace();

    const results = await Promise.allSettled([
      startSession({ taskId }),
      startSession({ taskId }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startSession>>> =>
        r.status === "fulfilled"
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(repo.RepoError);
    expect((rejected[0].reason as Error).message).toMatch(/already has an active session/);
    expect((rejected[0].reason as repo.RepoError).status).toBe(409);

    // Exactly one implement run row exists for this task — no duplicate
    // worktree/session was created by the loser.
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(fulfilled[0].value.id);
  });
});
