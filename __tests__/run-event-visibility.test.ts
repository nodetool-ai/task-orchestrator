import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { db } from "../db";
import { agentMessages, agentSessions, inboxEvents, runEventDeliveryMatches, runEventSubscriptions, runSourceEvents } from "../db/schema";
import { registerSubscriptionTx, publishSourceEventTx, unsubscribeRunEvents, registerDefaultChildSubscriptionTx } from "../lib/run-source-events";
import { materializeInboxEventsTx, claimRunTurn } from "../lib/run-inputs";
import { claimInboxEvents, emitInboxEvent } from "../lib/inbox";
import { listMessages } from "../lib/runs";
import { readStreamSince, ZERO_CURSOR } from "../lib/run-stream";
import { EVENT_TOOLS } from "../lib/extensions/events";

async function run(parentRunId: number | null = null, deliveryVersion = 2) {
  const [r] = await db.insert(agentSessions).values({ parentRunId, deliveryVersion, status: "pending", goal: "<chat>" }).returning();
  return r;
}
async function subscribe(subscriberRunId: number, sourceRunId: number, events = ["run.turn_finished"]) {
  return db.transaction(tx => registerSubscriptionTx(tx, { subscriberRunId, sourceRunId, events,
    attempt: 1, replay: "future_only", lifetime: "until_unsubscribed", keepOpen: false }));
}
async function publish(sourceRunId: number, key = "turn:1", eventType = "run.turn_finished", attempt = 1) {
  return db.transaction(tx => publishSourceEventTx(tx, { sourceRunId, attempt, eventType, producerKey: key, payload: { summary: key } }));
}
beforeEach(async () => {
  await db.delete(inboxEvents); await db.delete(runEventSubscriptions); await db.delete(runSourceEvents); await db.delete(agentSessions);
});

describe("subscription boundaries", () => {
  it("delivers only matching source, type and attempt; ancestry and siblings grant no visibility", async () => {
    const root = await run(); const parent = await run(root.id); const child = await run(parent.id); const sibling = await run(root.id);
    await subscribe(parent.id, child.id);
    await publish(child.id); await publish(child.id, "other-type", "run.question_opened"); await publish(child.id, "other-attempt", "run.turn_finished", 2);
    for (const id of [root.id, sibling.id, child.id]) {
      expect(await db.transaction(tx => materializeInboxEventsTx(tx, id))).toEqual([]);
      expect(await listMessages(id)).toEqual([]);
    }
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, parent.id))).toHaveLength(1);
    const history = await listMessages(parent.id);
    expect(history).toHaveLength(1);
    expect(history[0].content[0]).toMatchObject({ type: "run_event", source: { run_id: child.id, attempt: 1 }, payload: { summary: "turn:1" } });
    expect((await readStreamSince(parent.id, ZERO_CURSOR)).frames.filter(f => f.kind === "message")).toHaveLength(1);
  });

  it("rejects forged recipient matches, raw lifecycle deliveries and old ancestor copies before poll, claim and display", async () => {
    const root = await run(); const parent = await run(root.id); const child = await run(parent.id);
    const sub = await subscribe(parent.id, child.id); const fact = await publish(child.id);
    const bad = await db.insert(inboxEvents).values([
      { targetRunId: root.id, type: "run_event", sourceKind: "run", sourceEventId: fact!.id },
      { targetRunId: root.id, type: "child.result", sourceKind: "run", sourceId: String(child.id) },
      { targetRunId: root.id, type: "gh.pr.merged", sourceKind: "github", audience: "supervisor", bubbledFrom: parent.id },
    ]).returning();
    // Even a recorded match for somebody ELSE does not authorize this target.
    await db.insert(runEventDeliveryMatches).values({ deliveryId: bad[0].id, subscriptionId: sub.id });
    await db.insert(agentMessages).values({ runId: root.id, role: "system", content: JSON.stringify([{ type: "event_digest", events: bad.map(e => ({ event_id: e.id, type: e.type })) }]) });
    const poll = EVENT_TOOLS.find(t => t.name === "events__poll")!;
    const polled = await poll.execute({}, { runId: root.id } as any);
    expect(JSON.parse((polled.content[0] as any).text).events).toEqual([]);
    expect(await listMessages(root.id)).toEqual([]);
    const tail = await readStreamSince(root.id, ZERO_CURSOR);
    expect(tail.frames).toEqual([]); expect(tail.cursor.msgId).toBeGreaterThan(0);
    expect(await claimInboxEvents(root.id)).toEqual([]);
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, root.id))).toEqual([]);
    expect((await db.select().from(inboxEvents).where(eq(inboxEvents.targetRunId, root.id))).every(e => e.errorReason === "not_subscribed")).toBe(true);
  });

  it("filters individual digest envelopes and cross-run message copies while retaining owned inputs", async () => {
    const target = await run(); const other = await run();
    const own = await emitInboxEvent({ targetRunId: target.id, type: "timer.fired", sourceKind: "timer", noWake: true });
    const foreign = await emitInboxEvent({ targetRunId: other.id, type: "timer.fired", sourceKind: "timer", noWake: true });
    await db.insert(agentMessages).values({ runId: target.id, role: "system", content: JSON.stringify([{ type: "event_digest", events: [
      { event_id: own.eventId, type: "timer.fired" }, { event_id: foreign.eventId, type: "timer.fired" },
    ] }]) });
    const history = await listMessages(target.id);
    expect((history.at(-1)!.content[0] as any).events.map((e: any) => e.event_id)).toEqual([own.eventId]);
    const parent = await run(); const child = await run(parent.id);
    await emitInboxEvent({ targetRunId: child.id, type: "gh.pr.merged", sourceKind: "github", noWake: true });
    expect(await listMessages(parent.id)).toEqual([]);
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, child.id))).toHaveLength(1);
    // Only the typed delivery is shown after materialization, not its eager mirror.
    expect(await listMessages(child.id)).toHaveLength(1);
  });

  it("discards queued inputs and retracts their chat cards, while another matching subscription preserves delivery", async () => {
    const p = await run(); const c = await run(p.id);
    const a = await subscribe(p.id, c.id); const b = await subscribe(p.id, c.id);
    await publish(c.id); await db.transaction(tx => materializeInboxEventsTx(tx, p.id));
    const history = await listMessages(p.id); expect(history).toHaveLength(1);
    const before = await readStreamSince(p.id, ZERO_CURSOR);
    await unsubscribeRunEvents(p.id, a.id, { discardPending: true });
    expect(await listMessages(p.id)).toHaveLength(1);
    await unsubscribeRunEvents(p.id, b.id, { discardPending: true });
    expect(await listMessages(p.id)).toEqual([]);
    const tail = await readStreamSince(p.id, before.cursor);
    expect(tail.frames.map(f => f.kind === "event" ? f.data : null)).toContainEqual({ type: "messages_removed", messageIds: [history[0].id] });
    expect(await db.transaction(tx => claimRunTurn(tx, p.id))).toBeNull();
    await publish(c.id, "later");
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, p.id))).toEqual([]);
  });

  it("retains previously subscribed queued and executing history when it was not discarded", async () => {
    const p = await run(); const c = await run(p.id); const sub = await subscribe(p.id, c.id);
    await publish(c.id); await unsubscribeRunEvents(p.id, sub.id);
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, p.id))).toHaveLength(1);
    const turn = await db.transaction(tx => claimRunTurn(tx, p.id)); expect(turn?.inputs).toHaveLength(1);
    await unsubscribeRunEvents(p.id, sub.id, { discardPending: true });
    expect(await listMessages(p.id)).toHaveLength(1);
  });

  it("requires a custom event subscription and delivers only to its addressed subscriber", async () => {
    const root = await run(); const sender = await run(root.id); const target = await run(root.id); const other = await run(root.id);
    const input = { targetRunId: target.id, type: "custom.ready", sourceKind: "run" as const, sourceId: String(sender.id), noWake: true };
    expect((await emitInboxEvent(input)).eventId).toBeNull();
    await subscribe(target.id, sender.id, ["custom.ready"]); await subscribe(other.id, sender.id, ["custom.ready"]);
    expect((await emitInboxEvent(input)).eventId).not.toBeNull();
    expect(await db.transaction(tx => materializeInboxEventsTx(tx, target.id))).toHaveLength(1);
    expect(await listMessages(other.id)).toEqual([]);
  });

  it("uses durable default subscriptions for legacy parents and never bubbles to their ancestor", async () => {
    const root = await run(null, 1); const parent = await run(root.id, 1); const child = await run(parent.id);
    await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, child));
    await publish(child.id, "finished", "run.attempt_finished");
    expect(await claimInboxEvents(parent.id)).toHaveLength(1);
    expect(await claimInboxEvents(root.id)).toEqual([]);
  });

  it("migrates only future supervision of live legacy children without reviving cancelled interests", async () => {
    const parent = await run(null, 1); const child = await run(parent.id);
    const cancelled = await run(parent.id); const terminal = await run(parent.id);
    await db.update(agentSessions).set({ status: "completed" }).where(eq(agentSessions.id, terminal.id));
    const prior = await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, cancelled));
    await unsubscribeRunEvents(parent.id, prior.id);
    await publish(child.id);
    const migration = readFileSync(new URL("../db/migrations/0044_subscription_boundaries.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration)); await db.execute(sql.raw(migration));
    const subs = await db.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.subscriberRunId, parent.id));
    expect(subs).toHaveLength(2);
    expect(subs.find(s => s.sourceRunId === cancelled.id)?.status).toBe("cancelled");
    expect(subs.find(s => s.sourceRunId === child.id)).toMatchObject({ startRevision: 2, replayMode: "future_only", status: "active" });
    expect(await claimInboxEvents(parent.id)).toEqual([]);
    await publish(child.id, "finished", "run.attempt_finished");
    expect(await claimInboxEvents(parent.id)).toHaveLength(1);
  });
});
