// __tests__/run-dispatch-claim.test.ts
// Concurrency regressions for the atomic claim and the post-spawn writes.
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

describe("dispatchRun claim guards", () => {
  // BUG 1: a cancel that races the dispatch (status→cancelled, cancelRequested=1)
  // must not be resurrected. The claim must skip 'cancelled' and leave the kill
  // switch intact — no worker gets spawned.
  it("does not claim a cancelled run and preserves cancelRequested", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "cancelled", cancelRequested: 1, completedAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    const spawn = vi.fn(() => 1234);
    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("already-claimed");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    expect(row.status).toBe("cancelled");
    expect(row.cancelRequested).toBe(1);
    expect(row.workerScope).toBeNull();
  });

  it("does not claim a closed run", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db
      .update(agentSessions)
      .set({ status: "closed", completedAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    const spawn = vi.fn(() => 1);
    expect(await dispatchRun(run.id, { spawn })).toBe("already-claimed");
    expect(spawn).not.toHaveBeenCalled();
    expect((await get(run.id))!.status).toBe("closed");
  });

  // BUG 2 (success write): a slow create can outlast a sweep that declared the
  // container-less run dead and re-dispatched it (container B takes the claim).
  // When the original create finally returns, its post-spawn write must NOT
  // repoint worker_scope back onto its own (now orphaned) container.
  it("post-spawn write no-ops when a re-dispatch supersedes the claim mid-spawn", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const stolenScope = `run-${run.id}-winner`;
    const spawn = vi.fn(async () => {
      // Simulate the sweep + re-dispatch stealing the claim while we "create".
      await db
        .update(agentSessions)
        .set({ status: "running", workerScope: stolenScope})
        .where(eq(agentSessions.id, run.id));
      return 5555; // our container's pid — now orphaned
    });

    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("already-claimed");
    const row = (await get(run.id))!;
    expect(row.workerScope).toBe(stolenScope); // winner's claim untouched
    expect(row.status).toBe("running");
  });

  // BUG 2 (failSpawn): if the original create throws AFTER a re-dispatch stole the
  // claim, failSpawn must not null the winner's healthy claim or mark the run failed.
  it("failSpawn no-ops when a re-dispatch owns the claim", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const stolenScope = `run-${run.id}-winner`;
    const spawn = vi.fn(async () => {
      await db
        .update(agentSessions)
        .set({ status: "running", workerScope: stolenScope})
        .where(eq(agentSessions.id, run.id));
      throw new Error("boom-superseded");
    });

    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("already-claimed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("running"); // NOT failed
    expect(row.workerScope).toBe(stolenScope); // claim not released
    expect(row.error).toBeFalsy();
  });

  // Baseline: when THIS dispatch keeps its claim through the spawn, failSpawn still
  // releases + fails (the ordinary bad-spawn path must be unaffected by the guard).
  it("failSpawn still fails the run when the claim is unchanged", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const result = await dispatchRun(run.id, {
      spawn: () => {
        throw new Error("boom-owned");
      },
    });
    expect(result).toBe("spawn-failed");
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/boom-owned/);
    expect(row.workerScope).toBeNull();
  });
});
