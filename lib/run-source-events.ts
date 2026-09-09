import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import {
  agentSessions,
  agentMessages,
  inboxEvents,
  runInputs,
  runEventDeliveryMatches,
  runEventSubscriptions,
  runSourceEvents,
} from "@/db/schema";

// The transaction callback type is extracted from the configured Drizzle DB so
// callers can pass their transaction unchanged without falling back to any.
export type SourceEventTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type SourceEvent = typeof runSourceEvents.$inferSelect;
export type PublishSourceEventInput = {
  sourceRunId: number;
  attempt: number;
  eventType: string;
  payload?: Record<string, unknown>;
  producerKey: string;
  logicalTurnId?: string | null;
  workerGeneration?: number | null;
  occurredAt?: Date;
};

export async function lockSourceTx(tx: SourceEventTx, runId: number): Promise<void> {
  // MVP graph serialization: every source publication/registration takes the
  // same coarse lock first, preventing source-vs-subscription lock inversion.
  await lockSubscriptionGraphTx(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'run-source:' + runId}, 0))`);
}
async function lockSubscriptionGraphTx(tx: SourceEventTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('run-subscription-graph', 0))`);
}

async function sourceRevision(tx: SourceEventTx, sourceRunId: number): Promise<number> {
  const rows = await tx
    .select({ revision: runSourceEvents.revision })
    .from(runSourceEvents)
    .where(eq(runSourceEvents.sourceRunId, sourceRunId))
    .orderBy(sql`${runSourceEvents.revision} DESC`)
    .limit(1);
  return (rows[0]?.revision ?? 0) + 1;
}

function matches(sub: any, event: PublishSourceEventInput): boolean {
  const types = Array.isArray(sub.eventTypes) ? sub.eventTypes : [];
  return types.includes(event.eventType) &&
    (sub.attemptMode === "all" || sub.resolvedAttempt == null || sub.resolvedAttempt === event.attempt);
}

/** Publish a canonical fact and fan it into inbox rows in the same transaction. */
export async function publishSourceEventTx(tx: SourceEventTx, input: PublishSourceEventInput): Promise<SourceEvent | null> {
  await lockSourceTx(tx, input.sourceRunId);
  const revision = await sourceRevision(tx, input.sourceRunId);
  const id = randomUUID();
  const inserted = await tx.insert(runSourceEvents).values({
    id, sourceRunId: input.sourceRunId, revision, attempt: input.attempt,
    logicalTurnId: input.logicalTurnId ?? null, workerGeneration: input.workerGeneration ?? null,
    eventType: input.eventType, payload: input.payload ?? {}, producerKey: input.producerKey,
    occurredAt: input.occurredAt ?? new Date(),
  }).onConflictDoNothing().returning();
  if (!inserted[0]) {
    const prior = await tx.select().from(runSourceEvents).where(and(eq(runSourceEvents.sourceRunId, input.sourceRunId), eq(runSourceEvents.producerKey, input.producerKey))).limit(1);
    return prior[0] ?? null;
  }
  const event = inserted[0];
  const subscriptions = await tx.select().from(runEventSubscriptions).where(and(eq(runEventSubscriptions.sourceRunId, input.sourceRunId), eq(runEventSubscriptions.status, "active")));
  for (const sub of subscriptions) {
    if (sub.lifetime === "attempt" && event.eventType === "run.attempt_finished" && event.attempt === sub.resolvedAttempt) {
      await tx.update(runEventSubscriptions).set({ status: "finished", finishedAt: new Date(), endRevision: event.revision }).where(eq(runEventSubscriptions.id, sub.id));
    }
    if (event.revision < sub.startRevision || (sub.endRevision != null && event.revision > sub.endRevision) || !matches(sub, input)) continue;
    const delivery = await tx.insert(inboxEvents).values({
      targetRunId: sub.subscriberRunId, type: "run_event", payload: { type: "run_event", schema_version: 1, event_id: event.id, delivery_id: null, source: { run_id: event.sourceRunId, attempt: event.attempt, revision: event.revision }, event_type: event.eventType, occurred_at: event.occurredAt.toISOString(), payload: event.payload },
      audience: "owner", sourceKind: "run", sourceId: String(event.sourceRunId), attempt: event.attempt, sourceEventId: event.id,
    }).onConflictDoNothing().returning({ id: inboxEvents.id });
    if (delivery[0]) {
      await tx.insert(runEventDeliveryMatches).values({ deliveryId: delivery[0].id, subscriptionId: sub.id }).onConflictDoNothing();
    } else {
      const existing = await tx.select({ id: inboxEvents.id }).from(inboxEvents).where(and(eq(inboxEvents.targetRunId, sub.subscriberRunId), eq(inboxEvents.sourceEventId, event.id))).limit(1);
      if (existing[0]) await tx.insert(runEventDeliveryMatches).values({ deliveryId: existing[0].id, subscriptionId: sub.id }).onConflictDoNothing();
    }
  }
  return event;
}

export type AttemptFinishedRow = {
  sourceRunId?: number; id?: number; attempt: number; status: string; summary?: string | null;
  error?: string | null; resultRef?: Record<string, unknown> | null; workerGeneration?: number | null;
  result?: Record<string, unknown> | null; prUrl?: string | null;
};

export async function publishAttemptFinishedTx(tx: SourceEventTx, row: AttemptFinishedRow): Promise<SourceEvent | null> {
  if (!["completed", "failed", "cancelled", "budget_exhausted", "closed"].includes(row.status)) return null;
  return publishSourceEventTx(tx, {
    sourceRunId: row.sourceRunId ?? row.id!, attempt: row.attempt, eventType: "run.attempt_finished",
    producerKey: `attempt:${row.attempt}:finished`, workerGeneration: row.workerGeneration,
    payload: { status: row.status === "closed" ? "cancelled" : row.status, ...(row.status === "closed" ? { reason: "closed" } : {}), summary: row.summary ?? null, error: row.error ?? null, result: row.result ?? null, pr_url: row.prUrl ?? null, result_ref: row.resultRef ?? { run_id: row.sourceRunId ?? row.id, attempt: row.attempt } },
  });
}

export async function registerDefaultChildSubscriptionTx(tx: SourceEventTx, child: { id: number; parentRunId: number | null; attempt: number }): Promise<any | null> {
  if (child.parentRunId == null || child.parentRunId === child.id) return null;
  const [parent] = await tx.select({ version: agentSessions.deliveryVersion }).from(agentSessions).where(eq(agentSessions.id, child.parentRunId));
  if (parent?.version !== 2) return null; // Existing runs retain legacy parent routing.
  return registerSubscriptionTx(tx, { subscriberRunId: child.parentRunId, sourceRunId: child.id, events: ["run.attempt_finished", "run.question_opened"], attempt: child.attempt, replay: "current_state", lifetime: "attempt", keepOpen: true, clientKey: `default-supervision:${child.id}:${child.attempt}` });
}

export async function registerSubscriptionTx(tx: SourceEventTx, input: { subscriberRunId: number; sourceRunId: number; events: string[]; attempt: number | "current" | "all"; replay: "current_state" | "future_only"; lifetime: "attempt" | "until_unsubscribed"; keepOpen: boolean; clientKey?: string }): Promise<any> {
  const allowedEvents = new Set(["run.turn_finished", "run.attempt_finished", "run.question_opened", "run.question_resolved", "run.worker_failed"]);
  if (!input.events.length || input.events.some(event => !allowedEvents.has(event))) throw new Error("Unsupported subscription event types");
  if (typeof input.attempt === "number" && (!Number.isSafeInteger(input.attempt) || input.attempt < 1)) throw new Error("Invalid attempt");
  if (input.clientKey !== undefined && (!input.clientKey.trim() || input.clientKey.length > 200)) throw new Error("Invalid client_key");
  if (input.subscriberRunId === input.sourceRunId) throw new Error("A run cannot subscribe to its own lifecycle events");
  if (input.lifetime === "attempt" && input.attempt === "all") throw new Error("attempt lifetime requires a concrete attempt");
  await lockSubscriptionGraphTx(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'run-subscriber:' + input.subscriberRunId}, 0))`);
  await lockSourceTx(tx, input.sourceRunId);
  const source = (await tx.select().from(agentSessions).where(eq(agentSessions.id, input.sourceRunId)).limit(1))[0];
  const subscriber = (await tx.select({ parent: agentSessions.parentRunId }).from(agentSessions).where(eq(agentSessions.id, input.subscriberRunId)).limit(1))[0];
  if (!source || !subscriber) throw new Error("Run not found");
  const roots = await tx.execute(sql`WITH RECURSIVE up(id,parent_run_id,path) AS (SELECT id,parent_run_id,ARRAY[id] FROM agent_runs WHERE id=${input.subscriberRunId} UNION ALL SELECT r.id,r.parent_run_id,up.path||r.id FROM agent_runs r JOIN up ON r.id=up.parent_run_id WHERE NOT r.id=ANY(up.path)) SELECT id AS root FROM up WHERE parent_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs p WHERE p.id=up.parent_run_id) LIMIT 1`);
  const sourceRoots = await tx.execute(sql`WITH RECURSIVE up(id,parent_run_id,path) AS (SELECT id,parent_run_id,ARRAY[id] FROM agent_runs WHERE id=${input.sourceRunId} UNION ALL SELECT r.id,r.parent_run_id,up.path||r.id FROM agent_runs r JOIN up ON r.id=up.parent_run_id WHERE NOT r.id=ANY(up.path)) SELECT id AS root FROM up WHERE parent_run_id IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs p WHERE p.id=up.parent_run_id) LIMIT 1`);
  if (!roots[0] || !sourceRoots[0] || roots[0].root !== sourceRoots[0].root) throw new Error("Runs are outside the subscriber's tree");
  if (input.clientKey) {
    const prior = await tx.select().from(runEventSubscriptions).where(and(eq(runEventSubscriptions.subscriberRunId, input.subscriberRunId), eq(runEventSubscriptions.clientKey, input.clientKey))).limit(1);
    if (prior[0]) {
      const same = JSON.stringify(prior[0].eventTypes) === JSON.stringify([...new Set(input.events)].sort()) && prior[0].sourceRunId === input.sourceRunId && prior[0].attemptMode === (input.attempt === "all" ? "all" : input.attempt === "current" ? "current" : "exact") && (input.attempt === "current" || input.attempt === "all" || prior[0].resolvedAttempt === input.attempt) && prior[0].replayMode === input.replay && prior[0].lifetime === input.lifetime && prior[0].keepOpen === input.keepOpen;
      if (!same) throw new Error("client_key already used with different parameters");
      return prior[0];
    }
  }
  if (input.keepOpen) {
    const cycle = await tx.execute(sql`WITH RECURSIVE edges(subscriber,source,path) AS (
      SELECT subscriber_run_id,source_run_id,ARRAY[subscriber_run_id,source_run_id] FROM run_event_subscriptions WHERE status='active' AND keep_open=true
      UNION ALL SELECT e.subscriber_run_id,e.source_run_id,edges.path||e.source_run_id FROM run_event_subscriptions e JOIN edges ON e.subscriber_run_id=edges.source WHERE e.status='active' AND e.keep_open=true AND NOT e.source_run_id=ANY(edges.path)
    ) SELECT 1 FROM edges WHERE subscriber=${input.sourceRunId} AND source=${input.subscriberRunId} LIMIT 1`);
    if (cycle.length) throw new Error("keep-open subscription would create an observation cycle");
  }
  const activeForSubscriber = await tx.execute(sql`SELECT count(*)::int AS count FROM run_event_subscriptions WHERE subscriber_run_id=${input.subscriberRunId} AND status='active'`);
  if (Number(activeForSubscriber[0]?.count ?? 0) >= 100) throw new Error("subscription limit reached for subscriber");
  const activeForSource = await tx.execute(sql`SELECT count(*)::int AS count FROM run_event_subscriptions WHERE source_run_id=${input.sourceRunId} AND status='active'`);
  if (Number(activeForSource[0]?.count ?? 0) >= 100) throw new Error("subscription observer limit reached for source");
  const revision = await sourceRevision(tx, input.sourceRunId);
  const resolvedAttempt = input.attempt === "current" ? source.attempt : input.attempt === "all" ? null : input.attempt;
  const startRevision = input.replay === "future_only" ? revision : Math.max(0, revision - 1);
  const alreadyFinished = resolvedAttempt === source.attempt && ["completed", "failed", "cancelled", "budget_exhausted", "closed"].includes(source.status);
  const [sub] = await tx.insert(runEventSubscriptions).values({ id: randomUUID(), subscriberRunId: input.subscriberRunId, sourceRunId: input.sourceRunId, eventTypes: [...new Set(input.events)].sort(), attemptMode: input.attempt === "all" ? "all" : input.attempt === "current" ? "current" : "exact", resolvedAttempt, replayMode: input.replay, lifetime: input.lifetime, keepOpen: input.keepOpen, startRevision, clientKey: input.clientKey ?? null }).returning();
  if (input.replay === "future_only" && input.lifetime === "attempt" && alreadyFinished) {
    await tx.update(runEventSubscriptions).set({ status: "finished", finishedAt: new Date(), endRevision: revision - 1 }).where(eq(runEventSubscriptions.id, sub.id));
  }
  if (input.replay === "current_state") {
    const currentRows = await tx.select().from(runSourceEvents).where(and(eq(runSourceEvents.sourceRunId, input.sourceRunId), eq(runSourceEvents.attempt, resolvedAttempt ?? source.attempt), eq(runSourceEvents.eventType, "run.attempt_finished"))).orderBy(sql`${runSourceEvents.revision} DESC`).limit(1);
    if (input.lifetime === "attempt" && currentRows[0]) {
      await tx.update(runEventSubscriptions).set({ status: "finished", finishedAt: new Date(), endRevision: currentRows[0].revision }).where(eq(runEventSubscriptions.id, sub.id));
    }
    const current = input.events.includes("run.attempt_finished") ? currentRows : [];
    for (const fact of current) await publishMatchedFactTx(tx, sub, fact);
    if (current.length === 0 && resolvedAttempt === source.attempt && ["completed", "failed", "cancelled", "budget_exhausted"].includes(source.status) && input.events.includes("run.attempt_finished")) {
      await publishAttemptFinishedTx(tx, { sourceRunId: input.sourceRunId, attempt: resolvedAttempt ?? source.attempt, status: source.status, summary: source.outcome, error: source.error, result: source.result as Record<string, unknown> | null, prUrl: source.prUrl });
    }
    if (source.pendingQuestion && typeof source.pendingQuestion === "object" && input.events.includes("run.question_opened")) {
      const q = source.pendingQuestion as Record<string, unknown>;
      if (q.state === "open" || q.state == null) {
        const opened = await tx.select().from(runSourceEvents).where(and(eq(runSourceEvents.sourceRunId, input.sourceRunId), eq(runSourceEvents.attempt, resolvedAttempt ?? source.attempt), eq(runSourceEvents.eventType, "run.question_opened"))).orderBy(sql`${runSourceEvents.revision} DESC`).limit(1);
        if (opened[0] && (opened[0].payload as any)?.question_id === q.question_id) await publishMatchedFactTx(tx, sub, opened[0]);
      }
    }
  }
  return (await tx.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.id, sub.id)))[0];
}

async function publishMatchedFactTx(tx: SourceEventTx, sub: any, fact: any): Promise<void> {
  const [delivery] = await tx.insert(inboxEvents).values({ targetRunId: sub.subscriberRunId, type: "run_event", payload: { type: "run_event", schema_version: 1, event_id: fact.id, source: { run_id: fact.sourceRunId, attempt: fact.attempt, revision: fact.revision }, event_type: fact.eventType, occurred_at: fact.occurredAt.toISOString(), payload: fact.payload }, audience: "owner", sourceKind: "run", sourceId: String(fact.sourceRunId), attempt: fact.attempt, sourceEventId: fact.id }).onConflictDoNothing().returning({ id: inboxEvents.id });
  const deliveryId = delivery?.id ?? (await tx.select({ id: inboxEvents.id }).from(inboxEvents).where(and(eq(inboxEvents.targetRunId, sub.subscriberRunId), eq(inboxEvents.sourceEventId, fact.id))).limit(1))[0]?.id;
  if (deliveryId) await tx.insert(runEventDeliveryMatches).values({ deliveryId, subscriptionId: sub.id }).onConflictDoNothing();
  if (sub.lifetime === "attempt" && fact.eventType === "run.attempt_finished") await tx.update(runEventSubscriptions).set({ status: "finished", finishedAt: new Date(), endRevision: fact.revision }).where(eq(runEventSubscriptions.id, sub.id));
}

export async function hasOutstandingSupervisionTx(tx: SourceEventTx, subscriberId: number): Promise<boolean> {
  const rows = await tx.execute(sql`SELECT 1 FROM run_event_subscriptions s WHERE s.subscriber_run_id=${subscriberId} AND s.keep_open=true AND (s.status='active' OR EXISTS (SELECT 1 FROM inbox_events i JOIN run_event_delivery_matches m ON m.delivery_id=i.id LEFT JOIN agent_messages am ON am.event_delivery_id=i.id LEFT JOIN run_inputs ri ON ri.message_id=am.id WHERE m.subscription_id=s.id AND (i.status='pending' OR (i.status='injected' AND ri.status IN ('pending','assigned'))))) LIMIT 1`);
  return rows.length > 0;
}

export async function unsubscribeRunEvents(subscriberRunId: number, subscriptionId: string, options: { discardPending?: boolean } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const [sub] = await tx.select({ id: runEventSubscriptions.id, sourceRunId: runEventSubscriptions.sourceRunId }).from(runEventSubscriptions).where(and(eq(runEventSubscriptions.id, subscriptionId), eq(runEventSubscriptions.subscriberRunId, subscriberId(subscriberRunId))));
    if (!sub) return;
    await lockSubscriptionGraphTx(tx);
    await lockSourceTx(tx, sub.sourceRunId);
    await tx.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, subscriberRunId)).for("update");
    await tx.update(runEventSubscriptions).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(runEventSubscriptions.id, subscriptionId));
    if (options.discardPending) {
      await tx.update(inboxEvents).set({ status: "error", errorReason: "subscription_cancelled" }).where(and(
        eq(inboxEvents.targetRunId, subscriberRunId), eq(inboxEvents.status, "pending"),
        sql`${inboxEvents.id} IN (SELECT m.delivery_id FROM run_event_delivery_matches m WHERE m.subscription_id = ${subscriptionId} AND NOT EXISTS (SELECT 1 FROM run_event_delivery_matches m2 JOIN run_event_subscriptions s2 ON s2.id=m2.subscription_id WHERE m2.delivery_id=m.delivery_id AND m2.subscription_id<>m.subscription_id AND s2.status IN ('active','finished')))`
      ));
      await tx.execute(sql`UPDATE run_inputs ri SET status='cancelled', cancelled_at=now() WHERE ri.status='pending' AND ri.message_id IN (SELECT am.id FROM agent_messages am WHERE am.event_delivery_id IN (SELECT m.delivery_id FROM run_event_delivery_matches m WHERE m.subscription_id=${subscriptionId} AND NOT EXISTS (SELECT 1 FROM run_event_delivery_matches m2 JOIN run_event_subscriptions s2 ON s2.id=m2.subscription_id WHERE m2.delivery_id=m.delivery_id AND m2.subscription_id<>m.subscription_id AND s2.status IN ('active','finished'))))`);
    }
  });
}

function subscriberId(id: number): number { return id; }

export async function subscribeRunEvents(input: { subscriberRunId: number; sourceRunId: number; events: string[]; attempt: number | "current" | "all"; replay: "current_state" | "future_only"; lifetime: "attempt" | "until_unsubscribed"; keepOpen: boolean; clientKey?: string }): Promise<any> { return db.transaction((tx) => registerSubscriptionTx(tx, input)); }
export async function listRunSubscriptions(runId: number): Promise<any[]> { return db.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.subscriberRunId, runId)).orderBy(asc(runEventSubscriptions.createdAt)); }
