// __tests__/reconcile-orphaned-runs.test.ts
//
// A process that dies mid-turn (e.g. OOM-killed) leaves its run in an active
// status ('running' etc.) forever — append's guard then rejects every new
// message as "already in flight". reconcileOrphanedRuns() self-heals these on
// boot using the heartbeat lease: stale heartbeat => orphaned => demote.
// A run live in ANOTHER process keeps its heartbeat fresh and must be spared.

import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, agentEvents } from "../db/schema";
import { create, get, reconcileOrphanedRuns } from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";

const STALE = new Date(Date.now() - 10 * 60_000); // 10 min ago
const FRESH = new Date(Date.now() - 5_000); // 5 s ago

async function setRun(id: number, status: string, heartbeatAt: Date | null) {
  await db.update(agentSessions)
    .set({ status, heartbeatAt })
    .where(eq(agentSessions.id, id));
}

describe("reconcileOrphanedRuns", () => {
  it("demotes a stale-heartbeat running chat run to idle", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await setRun(run.id, "running", STALE);

    await reconcileOrphanedRuns();

    expect((await get(run.id))?.status).toBe("idle");
  });

  it("demotes a stale-heartbeat running implement run to failed with an error", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, "running", STALE);

    await reconcileOrphanedRuns();

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toMatch(/interrupt/i);
  });

  it("treats a NULL heartbeat in an active status as orphaned", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await setRun(run.id, "preparing", null);

    await reconcileOrphanedRuns();

    expect((await get(run.id))?.status).toBe("idle");
  });

  it("spares an active run whose heartbeat is fresh (live in another process)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await setRun(run.id, "running", FRESH);

    await reconcileOrphanedRuns();

    expect((await get(run.id))?.status).toBe("running");
  });

  it("ignores runs already in a terminal/idle status", async () => {
    const idle = await create({ goal: "<chat>", defer: true });
    await setRun(idle.id, "idle", STALE);
    const done = await create({ goal: "<implement>", defer: true });
    await setRun(done.id, "completed", STALE);

    await reconcileOrphanedRuns();

    expect((await get(idle.id))?.status).toBe("idle");
    expect((await get(done.id))?.status).toBe("completed");
  });

  it("finalizes an orphan as completed when its latest status event is 'completed'", async () => {
    // Regression: under a DB outage the completion EVENT can land while the
    // terminal column write is lost, stranding the row in a lease status. The
    // reaper must not clobber such a run to 'failed' — it already finished.
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, "running", STALE);
    await db.insert(agentEvents).values({
      sessionId: run.id,
      type: "status",
      payload: JSON.stringify({ status: "completed" }),
    });

    await reconcileOrphanedRuns();

    const after = await get(run.id);
    expect(after?.status).toBe("completed");
    expect(after?.error).toBeNull();
  });

  it("still fails an orphan whose latest status event is a later 'running' (not the stale completed)", async () => {
    // A resumed run that completed one turn, then orphaned mid a LATER turn:
    // the newest status event is 'running', so it is a genuine orphan.
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, "running", STALE);
    await db.insert(agentEvents).values({
      sessionId: run.id,
      type: "status",
      payload: JSON.stringify({ status: "completed" }),
    });
    await db.insert(agentEvents).values({
      sessionId: run.id,
      type: "status",
      payload: JSON.stringify({ status: "running" }),
    });

    await reconcileOrphanedRuns();

    expect((await get(run.id))?.status).toBe("failed");
  });

  it("re-dispatches a stale resumable worktree run when the flag is on", async () => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
    const spy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "<implement>", defer: true });
    // Make it look resumable: worktree run, has a session, worktree exists.
    await db.update(agentSessions)
      .set({ status: "running", heartbeatAt: STALE, sdkSessionId: "sess-1", worktreePath: process.cwd() })
      .where(eq(agentSessions.id, run.id));

    await reconcileOrphanedRuns();

    expect(spy).toHaveBeenCalledWith(run.id);
    expect((await get(run.id))?.status).not.toBe("failed");
    delete process.env.TASK_ORCH_DETACHED_RUNS;
    vi.restoreAllMocks();
  });
});
