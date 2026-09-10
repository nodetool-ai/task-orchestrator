/** Durable delivery recovery and best-effort wake hints. No model calls here. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentMessages, agentSessions, runnerInstances } from "@/db/schema";
import { claimRunTurn, materializeInboxEventsTx, type ClaimedRunTurn } from "./run-inputs";
import { isServerRuntimeRun } from "./run-runtime";
import type { RunInput } from "./worker-channel/protocol";
import { hasPendingInboxEvents } from "./inbox";
import { discardUnsubscribedEventsTx, filterConversationEvents } from "./run-event-visibility";

export async function turnInputCommand(turn: ClaimedRunTurn): Promise<RunInput> {
  const ids = turn.inputs.map((input) => input.messageId);
  const messages = ids.length ? await db.select().from(agentMessages).where(and(
    eq(agentMessages.runId, turn.runId), inArray(agentMessages.id, ids),
  )) : [];
  const visible = await filterConversationEvents(turn.runId, messages.map(message => ({ ...message, content: JSON.parse(message.content) })));
  const byId = new Map(visible.map((message) => [message.id, message]));
  return {
    turnId: turn.id,
    inputIds: turn.inputs.map((input) => input.id),
    inputSeqs: turn.inputs.map((input) => input.inputSeq),
    messages: turn.inputs.map((input) => {
      const message = byId.get(input.messageId);
      if (!message) throw new Error(`Missing durable input message ${input.messageId}`);
      return { id: message.id, runId: turn.runId, role: message.role as "user" | "system", content: message.content };
    }),
  };
}

/** Materialize while active too; only the turn owner schedules active work. */
export async function deliverRunEvents(runId: number): Promise<void> {
  const runs = await import("./runs");
  let run = await runs.get(runId);
  if (!run) return;
  if (run.deliveryVersion !== 2) {
    await db.transaction(tx => discardUnsubscribedEventsTx(tx, runId));
    if (["idle", "parked"].includes(run.status) && await hasPendingInboxEvents(runId)) {
      await (await import("./run-dispatch")).dispatchRun(runId);
    }
    return;
  }
  await db.transaction((tx) => materializeInboxEventsTx(tx, runId));
  run = await runs.get(runId);
  if (!run || !["idle", "parked"].includes(run.status)) return;
  // Materialization and wake hints are independently retryable. Do not start
  // a worker for a delivery that was already assigned/completed by a prior
  // sweep, or for an empty inbox after a concurrent materializer won the race.
  const runnable = await db.execute(sql`
    SELECT 1 FROM run_inputs
     WHERE run_id = ${runId} AND status IN ('pending', 'assigned')
     LIMIT 1
  `);
  if (runnable.length === 0) return;
  if (isServerRuntimeRun(run) || !run.workerScope) {
    const { dispatchRun } = await import("./run-dispatch");
    await dispatchRun(runId);
    return;
  }
  await runs.ensureWorkerConnected(runId);
  const turn = await db.transaction(async (tx) => {
    const [fresh] = await tx.select().from(agentSessions).where(eq(agentSessions.id, runId)).for("update");
    if (!fresh || !["idle", "parked"].includes(fresh.status)) return null;
    const [runner] = await tx.select().from(runnerInstances).where(eq(runnerInstances.runId, runId));
    if (!runner) return null;
    return claimRunTurn(tx, runId, runner.workerGeneration);
  });
  if (turn) {
    const { sendCommand } = await import("./worker-channel/registry");
    await sendCommand(runId, "run.input", await turnInputCommand(turn), turn.id);
  }
}

/** Scan both unmaterialized deliveries and durable inputs after lost hints. */
let pumpCursor = 0;

export async function pumpRunEventDeliveries(limit = 50): Promise<void> {
  const batchLimit = Math.max(1, Math.min(limit, 500));
  const candidates = await db.execute(sql`
    SELECT r.id FROM agent_runs r
    WHERE (
        (r.status IN ('pending','preparing','running') AND EXISTS (
          SELECT 1 FROM inbox_events e WHERE e.target_run_id=r.id
            AND e.status='pending' AND e.type NOT IN ('run.cancel_requested','run.budget_exhausted')
        ))
        OR
        (r.status IN ('idle','parked') AND (
          EXISTS (SELECT 1 FROM run_inputs i WHERE i.run_id=r.id AND i.status IN ('pending','assigned'))
          OR EXISTS (SELECT 1 FROM inbox_events e WHERE e.target_run_id=r.id AND e.status='pending' AND e.type NOT IN ('run.cancel_requested','run.budget_exhausted'))
        ))
      )
    ORDER BY CASE WHEN r.id > ${pumpCursor} THEN 0 ELSE 1 END, r.id LIMIT ${batchLimit}
  `);
  for (const candidate of candidates) {
    pumpCursor = Number(candidate.id);
    try { await deliverRunEvents(Number(candidate.id)); }
    catch (error) { console.error(`[run-events] Delivery to run ${candidate.id} deferred:`, error); }
  }
}

/** Hints never replace the pump: publication has already committed. */
let deliveryHint: Promise<void> | null = null;

export function hintRunEventDelivery(): void {
  // Publications can fan out to many observers in one transaction. Coalesce
  // their NOTIFY-style hints into one sweep; durable rows remain the source of
  // truth if a new publication commits while this sweep is running.
  if (deliveryHint) return;
  deliveryHint = pumpRunEventDeliveries()
    .catch((error) => console.error("[run-events] Delivery hint failed:", error))
    .finally(() => { deliveryHint = null; });
}
