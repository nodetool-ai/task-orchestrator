// __tests__/agent-reaper.test.ts
//
// Tests for the orphan reaper in lib/agent.ts. The reaper runs on module
// import in every process sharing the DB and must not aggressively reap
// valid pending runs. Pending rows are the dispatch queue and remain young
// until actually dispatched; only stale ones (older than a grace period)
// indicate their owning process died before dispatch.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, tasks, plans } from "../db/schema";
import { _reapOrphansForTest } from "../lib/agent";
import { create, get } from "../lib/runs";
import * as repo from "../lib/repo";

const YOUNG = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
const OLD = new Date(Date.now() - 20 * 60_000); // 20 minutes ago (beyond 15 min grace)

beforeEach(async () => {
  // Clear agent sessions, tasks, and plans before each test
  await db.delete(agentSessions);
  await db.delete(tasks);
  await db.delete(plans);
});

afterEach(() => {
  // No cleanup needed beyond beforeEach
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
      .set({ status: "pending", startedAt: YOUNG, heartbeatAt: null })
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
      .set({ status: "pending", startedAt: OLD, heartbeatAt: null })
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
      .set({ status: "preparing", startedAt: YOUNG, heartbeatAt: STALE })
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/[Oo]rphaned/);
  });

  it("spares a fresh-heartbeat preparing run (live in another process)", async () => {
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
      .set({ status: "preparing", startedAt: YOUNG, heartbeatAt: FRESH })
      .where(eq(agentSessions.id, run.id));

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
      .set({ status: "pending", startedAt: STALE, heartbeatAt: null })
      .where(eq(agentSessions.id, run.id));

    await _reapOrphansForTest();

    const after = await get(run.id);
    expect(after?.status).toBe("pending");
    expect(after?.error).toBeNull();
  });
});
