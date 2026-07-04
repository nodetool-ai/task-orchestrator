// __tests__/admission-children.test.ts
// M1: the admission-gate deadlock breaker — a run whose parent (a plan-executor
// blocked in await_session) still holds a live worker claim must be admitted
// even when the cap that made the gate say "defer" is otherwise saturated.
// Without this, every executor's children pile up in 'pending' while every
// executor blocks forever waiting on them — a livelock that eventually
// hard-fails the children on TASK_ORCH_MAX_DEFER_MS.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

const KNOBS = ["TASK_ORCH_WORKER_IMAGE"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
});

async function markLiveClaim(runId: number, ageMs = 0): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      status: "running",
      workerScope: `parent-${runId}-scope`,
      heartbeatAt: new Date(Date.now() - ageMs),
    })
    .where(eq(agentSessions.id, runId));
}

describe("dispatchRun admission: parent-blocked-on-child deadlock breaker", () => {
  it("admits a child over the cap when its parent holds a live worker claim", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const parent = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parent.id);
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(child.id, { spawn, admit: () => "defer" });

    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = (await get(child.id))!;
    expect(row.status).toBe("preparing");
  });

  it("still defers a parentless run under the exact same cap", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(run.id, { spawn, admit: () => "defer" });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    expect((await get(run.id))?.status).toBe("pending");
  });

  it("still defers a child whose parent's claim has gone stale (parent likely dead/reaped)", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const parent = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parent.id, 6 * 60_000); // past the 5-minute staleness window
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(child.id, { spawn, admit: () => "defer" });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("still defers a child whose parent already released its claim (parked/idle)", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const parent = await create({ goal: "<chat>" }); // idle, no worker claim
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(child.id, { spawn, admit: () => "defer" });

    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does NOT exempt 'never-fits' even when the parent holds a live claim", async () => {
    // never-fits means a single worker's cap exceeds the whole host budget — a
    // fatal misconfiguration no parent claim can rescue.
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const parent = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parent.id);
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });

    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(child.id, { spawn, admit: () => "never-fits" });

    expect(result).toBe("spawn-failed");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(child.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/insufficient host memory/i);
  });
});
