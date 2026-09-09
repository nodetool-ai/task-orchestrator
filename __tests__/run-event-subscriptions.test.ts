import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, initDb } from "../db";
import { agentSessions, inboxEvents, runEventDeliveryMatches, runEventSubscriptions, runSourceEvents } from "../db/schema";
import { registerDefaultChildSubscriptionTx, registerSubscriptionTx, hasOutstandingSupervisionTx, publishAttemptFinishedTx } from "../lib/run-source-events";
import { materializeAndClaimRunTurn, completeRunTurnTx } from "../lib/run-inputs";

async function run(parentRunId: number | null = null, status = "pending") {
  const [r] = await db.insert(agentSessions).values({ status, parentRunId, goal: "<implement>", deliveryVersion: 2 }).returning({ id: agentSessions.id, attempt: agentSessions.attempt, parentRunId: agentSessions.parentRunId });
  return r;
}

beforeEach(async () => {
  await db.delete(inboxEvents); await db.delete(runEventSubscriptions); await db.delete(runSourceEvents); await db.delete(agentSessions);
});
beforeAll(async () => { await initDb(); });

describe("durable run event subscriptions", () => {
  it("registers default child supervision and keeps an idle parent open", async () => {
    const parent = await run(); const child = await run(parent.id);
    const sub = await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, child));
    expect(sub?.subscriberRunId).toBe(parent.id);
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, parent.id))).toBe(true);
  });
  it("rejects self and cross-tree subscriptions", async () => {
    const a = await run(); const b = await run();
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: a.id, sourceRunId: a.id, events: ["run.attempt_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: false }))).rejects.toThrow();
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: a.id, sourceRunId: b.id, events: ["run.attempt_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: false }))).rejects.toThrow();
  });
  it("replays a terminal completion once and deduplicates overlapping subscriptions", async () => {
    const parent = await run(); const child = await run(parent.id, "completed");
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: child.id, attempt: 1, status: "completed" }));
    const a = await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: parent.id, sourceRunId: child.id, events: ["run.attempt_finished"], attempt: "current", replay: "current_state", lifetime: "attempt", keepOpen: true, clientKey: "a" }));
    const b = await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: parent.id, sourceRunId: child.id, events: ["run.attempt_finished"], attempt: "current", replay: "current_state", lifetime: "attempt", keepOpen: true, clientKey: "b" }));
    expect(a.id).not.toBe(b.id);
    expect((await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, parent.id)))).toHaveLength(1);
    expect((await db.select().from(runEventDeliveryMatches))).toHaveLength(2);
  });
  it("client keys reject changed parameters and preserve retries", async () => {
    const p = await run(); const c = await run(p.id);
    const input = { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.attempt_finished"], attempt: "current" as const, replay: "future_only" as const, lifetime: "attempt" as const, keepOpen: true, clientKey: "same" };
    const first = await db.transaction(tx => registerSubscriptionTx(tx, input));
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { ...input, keepOpen: false }))).rejects.toThrow();
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { ...input, replay: "current_state" }))).rejects.toThrow();
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { ...input, lifetime: "until_unsubscribed" }))).rejects.toThrow();
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { ...input, attempt: "all" }))).rejects.toThrow();
  });
  it("retries a current subscription after the source attempt advances", async () => {
    const p = await run(); const c = await run(p.id);
    const input = { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.attempt_finished"], attempt: "current" as const, replay: "future_only" as const, lifetime: "until_unsubscribed" as const, keepOpen: true, clientKey: "advance" };
    const first = await db.transaction(tx => registerSubscriptionTx(tx, input));
    await db.update(agentSessions).set({ attempt: 2 }).where(eq(agentSessions.id, c.id));
    const retry = await db.transaction(tx => registerSubscriptionTx(tx, input));
    expect(retry.id).toBe(first.id);
  });
  it("rolls back a publication without leaving journal, inbox, or finish state", async () => {
    const p = await run(); const c = await run(p.id);
    await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.attempt_finished"], attempt: "current", replay: "future_only", lifetime: "attempt", keepOpen: true }));
    await expect(db.transaction(async tx => { await publishAttemptFinishedTx(tx, { id: c.id, attempt: 1, status: "completed" }); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await db.select().from(runSourceEvents)).toHaveLength(0);
    expect(await db.select().from(inboxEvents)).toHaveLength(0);
    expect((await db.select({ status: runEventSubscriptions.status }).from(runEventSubscriptions)) [0].status).toBe("active");
  });
  it("supervises three children through materialization and a complete manifest", async () => {
    const p = await run(); const children = await Promise.all([run(p.id), run(p.id), run(p.id)]);
    for (const c of children) await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, c));
    for (const c of children) await db.transaction(tx => publishAttemptFinishedTx(tx, { id: c.id, attempt: 1, status: "completed" }));
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, p.id))).toBe(true);
    const turn = await materializeAndClaimRunTurn(p.id, 1);
    expect(turn?.inputs).toHaveLength(3);
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, p.id))).toBe(true);
    expect(await db.transaction(tx => completeRunTurnTx(tx, { turnId: turn!.id, runId: p.id, workerGeneration: 1, instanceId: "test", inputIds: turn!.inputs.map(i => i.id) }))).toBe(true);
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, p.id))).toBe(false);
  });
  it("rejects cyclic parent graphs", async () => {
    const a = await run(); const b = await run(a.id);
    await db.update(agentSessions).set({ parentRunId: b.id }).where(eq(agentSessions.id, a.id));
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: a.id, sourceRunId: b.id, events: ["run.attempt_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: true }))).rejects.toThrow();
  });
  it("rejects cycles in keep-open observation edges", async () => {
    const root = await run(); const a = await run(root.id); const b = await run(root.id);
    await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: a.id, sourceRunId: b.id, events: ["run.turn_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: true }));
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: b.id, sourceRunId: a.id, events: ["run.turn_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: true }))).rejects.toThrow();
  });
  it("does not synthesize current terminal state for an old attempt", async () => {
    const p = await run(); const c = await run(p.id, "completed");
    await db.update(agentSessions).set({ attempt: 2 }).where(eq(agentSessions.id, c.id));
    await expect(db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.attempt_finished"], attempt: 1, replay: "current_state", lifetime: "attempt", keepOpen: true }))).resolves.toBeTruthy();
    expect(await db.select().from(inboxEvents)).toHaveLength(0);
  });
  it("closes finite subscriptions on completion even when filtered", async () => {
    const p = await run(); const c = await run(p.id);
    const s = await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.question_opened"], attempt: "current", replay: "future_only", lifetime: "attempt", keepOpen: true }));
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: c.id, attempt: 1, status: "completed" }));
    expect((await db.select({ status: runEventSubscriptions.status }).from(runEventSubscriptions).where(eq(runEventSubscriptions.id, s.id)))[0].status).toBe("finished");
  });
  it("unsubscribing a queued delivery clears supervision", async () => {
    const p = await run(); const c = await run(p.id);
    const s = await db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId: p.id, sourceRunId: c.id, events: ["run.attempt_finished"], attempt: "current", replay: "future_only", lifetime: "until_unsubscribed", keepOpen: true }));
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: c.id, attempt: 1, status: "completed" }));
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, p.id))).toBe(true);
    const { unsubscribeRunEvents } = await import("../lib/run-source-events");
    await unsubscribeRunEvents(p.id, s.id, { discardPending: true });
    expect(await db.transaction(tx => hasOutstandingSupervisionTx(tx, p.id))).toBe(false);
  });
});
