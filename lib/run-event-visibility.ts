import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

/** A parent pointer is not an event subscription. Canonical deliveries need a
 * recorded match for this recipient and source. Local inputs (timers, owned
 * resource notifications, answers and platform notices) are directly addressed.
 * A cancelled subscription keeps previously matched deliveries unless the caller
 * discarded them; history must not disappear when supervision finishes. */
export function admittedInboxEvent(event: SQL = sql`inbox_events`): SQL {
  return sql`(
    (${event}.source_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM run_event_delivery_matches m
      JOIN run_event_subscriptions s ON s.id = m.subscription_id
      JOIN run_source_events f ON f.id = ${event}.source_event_id
      WHERE m.delivery_id = ${event}.id
        AND s.subscriber_run_id = ${event}.target_run_id
        AND s.source_run_id = f.source_run_id
        AND s.event_types @> jsonb_build_array(f.event_type)
        AND (s.attempt_mode = 'all' OR s.resolved_attempt = f.attempt)
    )) OR (
      ${event}.source_event_id IS NULL AND ${event}.type <> 'run_event'
      AND ${event}.audience = 'owner' AND ${event}.bubbled_from IS NULL
      AND ${event}.type NOT LIKE 'child.%' AND ${event}.type NOT LIKE 'custom.%'
      AND (${event}.source_kind <> 'run' OR ${event}.source_id = ${event}.target_run_id::text
           OR ${event}.type = 'question.answer')
    )
  )`;
}

/** Invalid old deliveries must not keep waking a run with an empty inbox. */
export async function discardUnsubscribedEventsTx(tx: { execute(query: SQL): Promise<unknown> }, runId: number): Promise<void> {
  await tx.execute(sql`UPDATE inbox_events SET status = 'error', error_reason = 'not_subscribed'
    WHERE target_run_id = ${runId} AND status = 'pending' AND NOT ${admittedInboxEvent()}`);
  await tx.execute(sql`UPDATE run_inputs ri SET status = 'cancelled', cancelled_at = NOW()
    FROM agent_messages am JOIN inbox_events i ON i.id = am.event_delivery_id
    WHERE ri.run_id = ${runId} AND ri.message_id = am.id AND ri.status = 'pending'
      AND (i.status IN ('error','superseded') OR i.target_run_id <> ${runId} OR NOT ${admittedInboxEvent(sql`i`)})`);
}

type Message = { id: number; runId: number; role: string; content: unknown[] };
type Block = Record<string, any>;
function deliveryId(block: Block): number | null {
  const raw = block.type === "run_event" ? block.delivery_id : block.event_id;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Shared by initial chat history, the SSE tail and worker snapshots. Validate
 * each envelope of legacy digests too, instead of trusting a whole system row.
 * Raw stored messages remain available for incident inspection. */
export async function filterConversationEvents<T extends Message>(runId: number, messages: T[]): Promise<T[]> {
  const ids = new Set<number>();
  for (const message of messages) {
    if (message.runId !== runId || message.role !== "system") continue;
    for (const block of message.content as Block[]) {
      if (!block || typeof block !== "object") continue;
      const events = block.type === "event_digest" ? (Array.isArray(block.events) ? block.events : []) : [block];
      for (const event of events) {
        if (block.type !== "event_digest" && !["run_event", "inbox_event"].includes(block.type)) continue;
        if (!event || typeof event !== "object") continue;
        const id = deliveryId(event);
        if (id != null) ids.add(id);
      }
    }
  }
  const visible = new Set<number>();
  const materialized = new Set<number>();
  if (ids.size) {
    const rows = await db.execute(sql`SELECT i.id,
      EXISTS (SELECT 1 FROM agent_messages am WHERE am.event_delivery_id = i.id) AS materialized
      FROM inbox_events i WHERE i.target_run_id = ${runId}
      AND i.id IN (${sql.join([...ids].map(id => sql`${id}`), sql`,`)})
      AND i.status IN ('pending','injected') AND ${admittedInboxEvent(sql`i`)}
      AND NOT EXISTS (SELECT 1 FROM agent_messages am JOIN run_inputs ri ON ri.message_id = am.id
                      WHERE am.event_delivery_id = i.id AND ri.status = 'cancelled')`);
    for (const row of rows) {
      visible.add(Number(row.id));
      if (row.materialized) materialized.add(Number(row.id));
    }
  }
  return messages.flatMap(message => {
    if (message.runId !== runId) return [];
    if (message.role !== "system") return [message];
    const content = (message.content as Block[]).flatMap(block => {
      if (!block || typeof block !== "object") return [block];
      if (block.type === "event_digest") {
        const events = (Array.isArray(block.events) ? block.events : []).filter((event: Block) =>
          event && visible.has(deliveryId(event) ?? -1));
        return events.length ? [{ ...block, events }] : [];
      }
      if (!["run_event", "inbox_event"].includes(block.type)) return [block];
      const id = deliveryId(block);
      if (id == null || !visible.has(id)) return [];
      // v2 has a single typed representation, never its old eager mirror too.
      if (block.type === "inbox_event" && materialized.has(id)) return [];
      return [block];
    });
    return content.length ? [{ ...message, content } as T] : [];
  });
}
