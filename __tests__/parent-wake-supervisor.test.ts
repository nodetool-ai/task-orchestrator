// __tests__/parent-wake-supervisor.test.ts
//
// A parked observer wakes only for matching subscriptions. Parent pointers do
// not grant access. Explicit PR subscriptions still work after the child ends.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, inboxEvents, runEventSubscriptions, runSourceEvents, runTimers } from "../db/schema";
import { registerSubscriptionTx } from "../lib/run-source-events";
import { seedPersonas } from "../db/seed-personas";
import { emitInboxEvent, parkedRunsWithPendingEvents } from "../lib/inbox";
import * as runDispatch from "../lib/run-dispatch";

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

async function subscribe(parent: number, child: number, event: string) {
  await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: parent, sourceRunId: child,
    events: [event], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: true }));
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(runTimers);
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(agentSessions);
});

afterEach(() => vi.restoreAllMocks());

describe("parent wake on subscribed child events", () => {
  it("wakes a parked parent when a gh.pr.merged owner event lands on its child", async () => {
    // The incident-shaped case: the child owns the PR and is terminal by merge
    // time, so its owner event is never claimed — the parked parent learns the
    // merge ONLY through the subscribed delivery, whose arrival must wake it.
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "completed" });
    await subscribe(parent, child, "gh.pr.merged");

    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "merge1",
      payload: { pr_url: "https://github.com/o/r/pull/7", merged_by: "octocat" },
    });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(parent));

    const copy = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(copy).toHaveLength(1);
    expect(copy[0].audience).toBe("owner");
    expect(copy[0].type).toBe("run_event");
    expect((copy[0].payload as any).event_type).toBe("gh.pr.merged");
  });

  it("wakes a parked parent when a gh.* owner event lands on its child", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "idle" });
    await subscribe(parent, child, "gh.pr.review_submitted");

    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.review_submitted",
      sourceKind: "github",
      sourceId: "d1",
      payload: { pr_url: "https://github.com/o/r/pull/7", state: "approved" },
    });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(parent));

    // The subscribed delivery did land on the parent.
    const copy = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(copy).toHaveLength(1);
    expect(copy[0].audience).toBe("owner");
    expect(copy[0].type).toBe("run_event");
    expect((copy[0].payload as any).event_type).toBe("gh.pr.review_submitted");
  });

  it("wakes a parked parent when a task.* owner event lands on its child", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "idle" });
    await subscribe(parent, child, "task.state_changed");

    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "task.state_changed",
      sourceKind: "task",
      sourceId: "t1",
      payload: { state: "merged" },
    });

    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(parent));
  });

  it("does NOT wake (and does not copy) when the parent is terminal", async () => {
    const parent = await insertRun({ status: "completed", completedAt: new Date() });
    const child = await insertRun({ parentRunId: parent, status: "idle" });

    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "d2",
      payload: { pr_url: "https://github.com/o/r/pull/8" },
    });

    expect(spy).not.toHaveBeenCalled();
    const copy = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(copy).toHaveLength(0);
  });

  it("does not wake when noWake is set, even though the subscribed delivery is written", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "idle" });
    await subscribe(parent, child, "gh.pr.merged");

    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "d3",
      payload: {},
      noWake: true,
    });

    expect(spy).not.toHaveBeenCalled();
    const copy = await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent));
    expect(copy).toHaveLength(1); // copy still written; only the wake is suppressed
  });

  it("a normal owner event to a parked run still wakes it (unchanged)", async () => {
    const run = await insertRun({ status: "parked" });
    const spy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "1",
    });

    expect(spy).toHaveBeenCalledWith(run);
  });
});

describe("parkedRunsWithPendingEvents (pump belt)", () => {
  it("includes a parked parent that has only a pending subscribed event", async () => {
    const parent = await insertRun({ status: "parked" });
    const child = await insertRun({ parentRunId: parent, status: "idle" });
    await subscribe(parent, child, "gh.pr.merged");

    await emitInboxEvent({
      targetRunId: child,
      type: "gh.pr.merged",
      sourceKind: "github",
      sourceId: "d4",
      payload: {},
      noWake: true, // isolate the pump-belt query from the emit-time wake
    });

    const ids = await parkedRunsWithPendingEvents();
    expect(ids).toContain(parent);
  });

  it("still includes a parked run with only a pending OWNER event", async () => {
    const run = await insertRun({ status: "parked" });

    await emitInboxEvent({
      targetRunId: run,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: "2",
      noWake: true,
    });

    const ids = await parkedRunsWithPendingEvents();
    expect(ids).toContain(run);
  });
});
