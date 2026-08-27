// __tests__/pump-ordering.test.ts
// listPendingRunIds ordering: pending children of a LIVE-claim parent must sort
// ahead of everything else, oldest-first among themselves; everyone else follows,
// oldest-first. This exists because pumpTick stops at the FIRST 'deferred'
// result (see lib/run-dispatch.ts) — a deferred root run ahead of a
// breaker-eligible child (lib/run-dispatch.ts's "Deadlock breaker (M1)") would
// trip that early break and starve the child until TASK_ORCH_MAX_DEFER_MS fails
// it, even though dispatchRun would have admitted it every time. See
// docs/nested-machine-dispatch.md, Decision 2, "Starvation fix (required)".
import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create } from "../lib/runs";
import { listPendingRunIds } from "../lib/runs";

async function markPending(runId: number): Promise<void> {
  await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, runId));
}

async function markLiveClaim(runId: number, ageMs = 0): Promise<void> {
  await db
    .update(agentSessions)
    .set({
      status: "running",
      workerScope: `parent-${runId}-scope`,
    })
    .where(eq(agentSessions.id, runId));
  installFakeRunnerProvider();
  // The old 5-minute heartbeat window is gone: age past it now means the
  // provider observes the parent's worker as dead.
  const observation = ageMs >= 5 * 60_000
    ? { status: "dead" as const, detail: "exited" }
    : { status: "alive" as const, incarnation: `p-${runId}` };
  await setFakeRunLiveness(runId, observation, `p-${runId}`);
}

// The schema is shared across `it` blocks in this file (vitest.setup.ts isolates
// per FILE, not per test), so other tests' pending rows may still be sitting in
// the table. Filter the full result down to the ids this test created, preserving
// relative order, so assertions aren't polluted by leftover state.
function among(ids: number[], subset: number[]): number[] {
  const want = new Set(subset);
  return ids.filter((id) => want.has(id));
}

describe("listPendingRunIds ordering", () => {
  it("sorts a pending child of a live-claim parent before an OLDER pending root run", async () => {
    const root = await create({ goal: "<implement>", defer: true });
    await markPending(root.id);
    const parent = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parent.id);
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });
    await markPending(child.id);

    const ids = await listPendingRunIds();
    expect(among(ids, [root.id, child.id])).toEqual([child.id, root.id]);
  });

  it("keeps oldest-first order between two pending children of (different) live parents", async () => {
    const parentA = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parentA.id);
    const childA = await create({ goal: "<implement>", defer: true, parentRunId: parentA.id });
    await markPending(childA.id);

    const parentB = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parentB.id);
    const childB = await create({ goal: "<implement>", defer: true, parentRunId: parentB.id });
    await markPending(childB.id);

    const ids = await listPendingRunIds();
    expect(among(ids, [childA.id, childB.id])).toEqual([childA.id, childB.id]);
  });

  it("does NOT prioritize a pending child whose parent's heartbeat has gone stale", async () => {
    const root = await create({ goal: "<implement>", defer: true });
    await markPending(root.id);
    const parent = await create({ goal: "<implement>", defer: true });
    await markLiveClaim(parent.id, 6 * 60_000); // observed dead by the provider
    const child = await create({ goal: "<implement>", defer: true, parentRunId: parent.id });
    await markPending(child.id);

    const ids = await listPendingRunIds();
    // No priority applied: falls back to plain oldest-first, and root is older.
    expect(among(ids, [root.id, child.id])).toEqual([root.id, child.id]);
  });

  it("treats a pending run with no parent as a root: plain oldest-first", async () => {
    const runA = await create({ goal: "<implement>", defer: true });
    await markPending(runA.id);
    const runB = await create({ goal: "<implement>", defer: true });
    await markPending(runB.id);

    const ids = await listPendingRunIds();
    expect(among(ids, [runA.id, runB.id])).toEqual([runA.id, runB.id]);
  });
});
