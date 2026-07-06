// __tests__/run-dispatch.test.ts
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

describe("dispatchRun", () => {
  it("claims an unclaimed run and calls spawn once", async () => {
    const run = await create({ goal: "<implement>", taskId: null as any, defer: true });
    const spawn = vi.fn(() => 5555);
    const result = await dispatchRun(run.id, { spawn });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = (await get(run.id))!;
    expect(row.status).toBe("preparing");
    expect(row.workerScope).toMatch(/^run-\d+-/);
    expect(row.workerPid).toBe(5555);
  });

  it("is idempotent — a second dispatch does not spawn again", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await dispatchRun(run.id, { spawn: () => 1 });
    const spawn2 = vi.fn(() => 2);
    expect(await dispatchRun(run.id, { spawn: spawn2 })).toBe("already-claimed");
    expect(spawn2).not.toHaveBeenCalled();
  });

  it("returns not-found for a missing run", async () => {
    expect(await dispatchRun(999999, { spawn: () => 1 })).toBe("not-found");
  });

  it("does not dispatch a run holding a live lease", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id));
    expect(await dispatchRun(run.id, { spawn: () => 1 })).toBe("already-claimed");
  });

  // Regression: a spawn that throws (bad module resolution in the prod bundle —
  // the 'Cannot find module tsx/cli' incident) must fail the run, not wedge it
  // in 'preparing' with no error and no worker.
  it("marks the run failed (not wedged in preparing) when spawn throws", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, {
      spawn: () => {
        throw new Error("boom-tsx");
      },
    });
    expect(result).toBe("spawn-failed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/boom-tsx/);
    expect(row.workerScope).toBeNull(); // claim released for retry
  });

  it("marks the run failed when spawn returns no pid (executable not found)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, { spawn: () => null });
    expect(result).toBe("spawn-failed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/did not start/);
  });

  // Regression (run 58): reviving a failed/completed run for a follow-up turn or
  // restart must clear the PRIOR attempt's terminal artifacts. Otherwise the
  // freshly-claimed, now-running row still carries a stale `error` and a past
  // `completed_at`, so a live run reads as failed in the UI.
  it("clears a prior attempt's error and completed_at when it re-claims the run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    // Simulate a run that failed a previous turn.
    await db
      .update(agentSessions)
      .set({ status: "failed", error: "Interrupted by a process restart", completedAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    const result = await dispatchRun(run.id, { spawn: () => 4242 });
    expect(result).toBe("spawned");
    const row = (await get(run.id))!;
    expect(row.status).toBe("preparing");
    expect(row.error).toBeNull();
    expect(row.completedAt).toBeNull();
  });
});
