// __tests__/inbox-visibility.test.ts
//
// UI read path of the agent event system (docs/agent-events.md §11): the
// helpers behind GET /api/runs/:id/inbox and the /runs index "N queued"
// badges. Read-only views — nothing here may mutate event lifecycle state.

import { beforeEach, describe, expect, it } from "vitest";

import { db } from "../db";
import { agentSessions, inboxEvents, runTimers } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import {
  createTimer,
  emitInboxEvent,
  listRunInboxEvents,
  listRunTimers,
  pendingOwnerCounts,
  quarantineEvent,
} from "../lib/inbox";

async function insertRun(
  values: Partial<typeof agentSessions.$inferInsert> = {}
): Promise<number> {
  const rows = await db
    .insert(agentSessions)
    .values({
      goal: "<execute>",
      toolsProfile: "orchestrator",
      cwdStrategy: "none",
      personaId: "implementor",
      status: "idle",
      startedAt: new Date(),
      ...values,
    })
    .returning({ id: agentSessions.id });
  return rows[0].id;
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(runTimers);
  await db.delete(inboxEvents);
  await db.delete(agentSessions);
});

describe("listRunInboxEvents", () => {
  it("returns every lifecycle state for the run, newest first, scoped to the run", async () => {
    const run = await insertRun({});
    const other = await insertRun({});

    const a = await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
      noWake: true,
    });
    const b = await emitInboxEvent({
      targetRunId: run,
      type: "child.result",
      sourceKind: "run",
      sourceId: "99",
      attempt: 1,
      noWake: true,
    });
    await emitInboxEvent({
      targetRunId: other,
      type: "gh.pr.merged",
      sourceKind: "github",
      noWake: true,
    });
    await quarantineEvent(a.eventId!, "payload exceeds cap");

    const rows = await listRunInboxEvents(run);
    expect(rows.map((r) => r.id)).toEqual([b.eventId, a.eventId]);
    expect(rows.find((r) => r.id === a.eventId)?.status).toBe("error");
    expect(rows.find((r) => r.id === a.eventId)?.errorReason).toBe("payload exceeds cap");
    expect(rows.find((r) => r.id === b.eventId)?.status).toBe("pending");
  });
});

describe("listRunTimers", () => {
  it("returns the run's timers, newest first", async () => {
    const run = await insertRun({});
    const t1 = await createTimer({ runId: run, minutes: 5, note: "watchdog" });
    const t2 = await createTimer({ runId: run, minutes: 30 });
    expect(t1.ok && t2.ok).toBe(true);

    const rows = await listRunTimers(run);
    expect(rows.map((r) => r.id)).toEqual([
      (t2 as { timerId: number }).timerId,
      (t1 as { timerId: number }).timerId,
    ]);
    expect(rows[1].note).toBe("watchdog");
  });
});

describe("pendingOwnerCounts", () => {
  it("counts only pending owner-audience events, grouped by run", async () => {
    const parent = await insertRun({});
    const run = await insertRun({ parentRunId: parent });

    // Two owner events for `run`; gh.* also fans a supervisor copy to the
    // parent, which must NOT count toward the parent's badge.
    await emitInboxEvent({
      targetRunId: run,
      type: "gh.pr.merged",
      sourceKind: "github",
      noWake: true,
    });
    const second = await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      noWake: true,
    });

    let counts = await pendingOwnerCounts();
    expect(counts.get(run)).toBe(2);
    expect(counts.get(parent)).toBeUndefined();

    // Leaving 'pending' removes an event from the badge.
    await quarantineEvent(second.eventId!, "poison");
    counts = await pendingOwnerCounts();
    expect(counts.get(run)).toBe(1);
  });
});
