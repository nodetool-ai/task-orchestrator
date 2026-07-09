// __tests__/atomic-finalize.test.ts
//
// Tier 1 — atomic run finalize. Incident: a terminal transition was written as
// two statements (status column UPDATE on agent_runs, then a paired status-event
// INSERT). Under DB pressure a worker's connection died BETWEEN them: the event
// landed, the column write was lost, and the orphan reaper mislabeled a finished
// run (PR already delivered) as `failed`. These tests pin the fix: the column
// write and its event are ONE transaction (both-or-neither), the finalize is
// idempotent (already-finalized = no-op, not an error), and the worker retry
// treats an ambiguous commit as success.

import { describe, expect, it, vi } from "vitest";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, agentEvents, runTimers } from "../db/schema";
import {
  create,
  get,
  cancel,
  close,
  setError,
  applyStatusTx,
  failPendingRun,
  finalizeWithRetry,
} from "../lib/runs";

const TERMINAL = ["completed", "failed", "cancelled", "closed", "budget_exhausted"];
const NOT_TERMINAL = notInArray(agentSessions.status, TERMINAL);

async function setRun(id: number, patch: Record<string, unknown>): Promise<void> {
  await db.update(agentSessions).set(patch).where(eq(agentSessions.id, id));
}

/** All status-event rows for a run whose payload carries `status`. */
async function statusEvents(id: number, status: string): Promise<unknown[]> {
  const rows = await db
    .select({ payload: agentEvents.payload })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, id), eq(agentEvents.type, "status")));
  return rows.filter((r) => {
    try {
      return (JSON.parse(r.payload) as { status?: string }).status === status;
    } catch {
      return false;
    }
  });
}

describe("applyStatusTx idempotency", () => {
  it("double-complete: second call is a no-op and exactly one completed event exists", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });

    const first = await applyStatusTx(run.id, "completed", {
      set: { completedAt: new Date() },
      guard: NOT_TERMINAL,
    });
    const second = await applyStatusTx(run.id, "completed", {
      set: { completedAt: new Date() },
      guard: NOT_TERMINAL,
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // already finalized → no-op, not an error
    expect((await get(run.id))?.status).toBe("completed");
    expect(await statusEvents(run.id, "completed")).toHaveLength(1);
  });

  it("cancels pending timers when a run reaches a terminal status", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    await setRun(run.id, { status: "running" });
    await db.insert(runTimers).values({
      runId: run.id,
      fireAt: new Date(Date.now() + 60_000),
      note: "await child",
      status: "pending",
    });

    await applyStatusTx(run.id, "completed", {
      set: { completedAt: new Date() },
      guard: NOT_TERMINAL,
    });

    const rows = await db.select({ status: runTimers.status }).from(runTimers).where(eq(runTimers.runId, run.id));
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });
});

describe("setError idempotency", () => {
  it("does not overwrite an already-completed run and appends no failed event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });
    await applyStatusTx(run.id, "completed", {
      set: { completedAt: new Date() },
      guard: NOT_TERMINAL,
    });

    await setError(run.id, "should be ignored");

    const after = await get(run.id);
    expect(after?.status).toBe("completed");
    expect(after?.error).toBeNull(); // error column NOT overwritten
    expect(await statusEvents(run.id, "failed")).toHaveLength(0);
  });

  it("twice on a live run emits exactly one failed event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });

    await setError(run.id, "boom");
    await setError(run.id, "boom again");

    expect((await get(run.id))?.status).toBe("failed");
    expect((await get(run.id))?.error).toBe("boom"); // first write wins
    expect(await statusEvents(run.id, "failed")).toHaveLength(1);
  });
});

describe("cancel idempotency", () => {
  it("cancel on an already-cancelled run emits exactly one cancelled event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });

    await cancel(run.id);
    await cancel(run.id); // early-returns on terminal status

    expect((await get(run.id))?.status).toBe("cancelled");
    expect(await statusEvents(run.id, "cancelled")).toHaveLength(1);
  });
});

describe("close cleanup", () => {
  it("cancels pending timers owned by the closed run", async () => {
    const run = await create({ goal: "<execute>", defer: true });
    await db.insert(runTimers).values({
      runId: run.id,
      fireAt: new Date(Date.now() + 60_000),
      note: "await child",
      status: "pending",
    });

    await close(run.id);

    const rows = await db.select({ status: runTimers.status }).from(runTimers).where(eq(runTimers.runId, run.id));
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });
});

describe("atomicity / rollback (the money test)", () => {
  it("rolls back the status column write when the paired event INSERT fails", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });

    // Break the event INSERT inside the tx by renaming the table out from under
    // it. The UPDATE lands first, then the INSERT hits a missing relation and
    // aborts the whole transaction — proving both-or-neither at the DB level.
    await db.execute(sql`ALTER TABLE agent_events RENAME TO agent_events_bak`);
    try {
      await expect(
        applyStatusTx(run.id, "completed", {
          set: { completedAt: new Date() },
          guard: NOT_TERMINAL,
        })
      ).rejects.toThrow();
    } finally {
      await db.execute(sql`ALTER TABLE agent_events_bak RENAME TO agent_events`);
    }

    // The column write must have rolled back with the failed event insert.
    expect((await get(run.id))?.status).toBe("running");
    expect(await statusEvents(run.id, "completed")).toHaveLength(0);
  });
});

describe("failPendingRun", () => {
  it("fails a pending unclaimed run: returns true, status failed, one event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "pending", workerScope: null });
    const ok = await failPendingRun(run.id, "no capacity");

    expect(ok).toBe(true);
    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.error).toBe("no capacity");
    expect(await statusEvents(run.id, "failed")).toHaveLength(1);
  });

  it("leaves a pending run WITH a worker claim untouched and emits no event", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "pending", workerScope: "worker-1" }); // claimed in the race window

    const ok = await failPendingRun(run.id, "no capacity");

    expect(ok).toBe(false);
    expect((await get(run.id))?.status).toBe("pending");
    expect(await statusEvents(run.id, "failed")).toHaveLength(0);
  });

  it("is a no-op on an already-failed run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "pending", workerScope: null });
    await failPendingRun(run.id, "first");
    const ok = await failPendingRun(run.id, "second");

    expect(ok).toBe(false);
    expect((await get(run.id))?.error).toBe("first");
    expect(await statusEvents(run.id, "failed")).toHaveLength(1);
  });
});

describe("finalizeWithRetry", () => {
  const transient = (): Error => Object.assign(new Error("boom"), { code: "CONNECTION_CLOSED" });

  it("retries a transient failure then reports the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(true);

    await expect(finalizeWithRetry(fn, 3)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("treats the ambiguous commit (retry returns false) as success", async () => {
    // First attempt committed but the ack was lost → transient throw. The retry
    // re-runs the guarded finalize, matches 0 rows, and returns false: the run
    // IS finalized, so the wrapper surfaces false (a success sentinel), not a throw.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(false);

    await expect(finalizeWithRetry(fn, 3)).resolves.toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-transient error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("application bug"));
    await expect(finalizeWithRetry(fn, 3)).rejects.toThrow("application bug");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget on a persistent transient error", async () => {
    const fn = vi.fn().mockRejectedValue(transient());
    await expect(finalizeWithRetry(fn, 2)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("ambiguous retry against a real transaction", () => {
  it("a retried finalize after a real commit returns false and finalizes exactly once", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await setRun(run.id, { status: "running" });

    // Simulate the ambiguous case end-to-end: the first (real) finalize commits;
    // the retry (as if the ack were lost) re-runs the same guarded finalize and
    // must return false — the run is already completed, exactly one event.
    const finalize = (): Promise<boolean> =>
      applyStatusTx(run.id, "completed", {
        set: { completedAt: new Date() },
        guard: NOT_TERMINAL,
      });

    expect(await finalize()).toBe(true);
    expect(await finalizeWithRetry(finalize, 3)).toBe(false);

    expect((await get(run.id))?.status).toBe("completed");
    expect(await statusEvents(run.id, "completed")).toHaveLength(1);
  });
});
