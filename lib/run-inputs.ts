/**
 * Durable conversation input and turn receipts.
 *
 * This module is deliberately transaction-first.  Callers which already own a
 * transaction must use the `*Tx` variants; none of those functions opens a
 * nested transaction.  The scheduler's source of truth is run_inputs, rather
 * than message ids or the legacy inbox digest.
 */
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { admittedInboxEvent, discardUnsubscribedEventsTx } from "./run-event-visibility";
import type { MessageSnapshot, RunInput } from "./worker-channel/protocol";

export type InputKind = "user" | "event";
export type InputStatus = "pending" | "assigned" | "completed" | "cancelled";

/** The intentionally small transaction surface used by server and channel code. */
export type RunInputsTx = { execute(query: SQL): Promise<unknown> };

export type RunInputRef = {
  id: string;
  runId: number;
  inputSeq: number;
  messageId: number;
  kind: InputKind;
  status: InputStatus;
  turnId?: string | null;
};

export type ClaimedRunTurn = {
  id: string;
  runId: number;
  ordinal: number;
  inputs: RunInputRef[];
  executionGeneration: number;
};

/** Stable channel payload builder shared by dispatch and snapshot bootstrap. */
export function buildTurnInputCommand(turn: ClaimedRunTurn, messages: MessageSnapshot[]): RunInput {
  const byId = new Map(messages.map((message) => [message.id, message]));
  return {
    turnId: turn.id,
    inputIds: turn.inputs.map((input) => input.id),
    inputSeqs: turn.inputs.map((input) => input.inputSeq),
    messages: turn.inputs.map((input) => {
      const message = byId.get(input.messageId);
      if (!message) throw new Error(`Missing message ${input.messageId} for turn ${turn.id}`);
      return message;
    }),
  };
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : []) as T[];
}

function asInt(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function asInput(row: Record<string, unknown>): RunInputRef {
  return {
    id: String(row.id),
    runId: asInt(row.run_id),
    inputSeq: asInt(row.input_seq),
    messageId: asInt(row.message_id),
    kind: String(row.kind) as InputKind,
    status: String(row.status) as InputStatus,
    turnId: row.assigned_turn_id == null ? null : String(row.assigned_turn_id),
  };
}

export type EnqueueInput = {
  runId: number;
  messageId: number;
  kind: InputKind;
  /** Stable identity supplied by an event materializer or retrying producer. */
  id?: string;
};

/** Insert a message's scheduling record, idempotently. */
export async function enqueueMessageTx(tx: RunInputsTx, input: EnqueueInput): Promise<RunInputRef> {
  const id = input.id ?? randomUUID();
  await tx.execute(sql`SELECT id FROM agent_runs WHERE id = ${input.runId} FOR UPDATE`);
  const message = rows(await tx.execute(sql`SELECT id FROM agent_messages WHERE id = ${input.messageId} AND run_id = ${input.runId}`));
  if (!message.length) throw new Error("Input message does not belong to target run");
  const result = await tx.execute(sql`
    INSERT INTO run_inputs (id, run_id, input_seq, message_id, kind, status, created_at)
    SELECT ${id}::uuid, ${input.runId}, COALESCE(MAX(input_seq), 0) + 1,
           ${input.messageId}, ${input.kind}, 'pending', NOW()
      FROM run_inputs
     WHERE run_id = ${input.runId}
    ON CONFLICT (message_id) DO UPDATE SET message_id = EXCLUDED.message_id
    RETURNING id, run_id, input_seq, message_id, kind, status, assigned_turn_id
  `);
  const row = rows<Record<string, unknown>>(result)[0];
  if (!row) throw new Error(`Unable to enqueue input for run ${input.runId}`);
  return asInput(row);
}

/** Alias used by user-message/control-plane callers. */
export function enqueueUserInputTx(tx: RunInputsTx, runId: number, messageId: number, id?: string): Promise<RunInputRef> {
  return enqueueMessageTx(tx, { runId, messageId, kind: "user", id });
}

/** Non-transaction convenience wrapper for callers that do not already write. */
export async function enqueueMessage(input: EnqueueInput): Promise<RunInputRef> {
  return db.transaction((tx) => enqueueMessageTx(tx, input));
}

/** Return whether the run has work which can be scheduled. */
export async function hasReadyRunInputsTx(tx: RunInputsTx, runId: number): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1 FROM run_inputs
     WHERE run_id = ${runId} AND status = 'pending'
     LIMIT 1
  `);
  return rows(result).length > 0;
}

export async function hasReadyRunInputs(runId: number): Promise<boolean> {
  return db.transaction((tx) => hasReadyRunInputsTx(tx, runId));
}

/**
 * Claim one serialized logical turn and its ordered input manifest.  The
 * caller must hold the run scheduling lock before invoking this function.
 */
export async function claimRunTurn(
  tx: RunInputsTx,
  runId: number,
  workerGeneration = 1,
  limit = 32
): Promise<ClaimedRunTurn | null> {
  const run = rows<Record<string, unknown>>(await tx.execute(sql`SELECT id, status, attempt FROM agent_runs WHERE id = ${runId} FOR UPDATE`))[0];
  if (!run || ['completed', 'failed', 'cancelled', 'closed', 'budget_exhausted'].includes(String(run.status))) return null;
  const currentAttempt = asInt(run.attempt ?? 1);
  await discardUnsubscribedEventsTx(tx, runId);
  const existing = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, run_id, ordinal, attempt, execution_generation, input_manifest
      FROM run_turns WHERE run_id = ${runId} AND state IN ('active','running')
      ORDER BY ordinal DESC LIMIT 1
  `))[0];
  if (existing) {
    // A terminal run resumed for corrective input increments agent_sessions.attempt.
    // Its prior unfinished receipt is an immutable historical fact: retire the
    // receipt and only its assigned inputs, leaving newly queued pending input
    // available to the new attempt.
    if (asInt(existing.attempt ?? 1) !== currentAttempt) {
      await tx.execute(sql`UPDATE run_turns SET state = 'superseded'
        WHERE id = ${String(existing.id)}::uuid AND run_id = ${runId}
          AND state IN ('active','running')`);
      await tx.execute(sql`UPDATE run_inputs SET status = 'cancelled', cancelled_at = NOW()
        WHERE run_id = ${runId} AND assigned_turn_id = ${String(existing.id)}::uuid
          AND status = 'assigned'`);
    } else {
      if (workerGeneration < asInt(existing.execution_generation)) return null;
      if (workerGeneration > asInt(existing.execution_generation)) {
        await tx.execute(sql`UPDATE run_turns SET execution_generation = ${workerGeneration},
          checkpoint = jsonb_build_object('recovered_from_generation', execution_generation, 'execution_uncertain', true)
          WHERE id = ${String(existing.id)}::uuid`);
      }
      let manifest: unknown = existing.input_manifest;
      if (typeof manifest === "string") {
        try { manifest = JSON.parse(manifest); } catch { manifest = []; }
      }
      manifest = Array.isArray(manifest) ? manifest : [];
      return { id: String(existing.id), runId, ordinal: asInt(existing.ordinal),
        executionGeneration: workerGeneration, inputs: manifest as RunInputRef[] };
    }
  }
  const turnId = randomUUID();
  const turnRows = rows<Record<string, unknown>>(await tx.execute(sql`
    INSERT INTO run_turns
      (id, run_id, ordinal, attempt, state, input_manifest, execution_generation, started_at)
    SELECT ${turnId}::uuid, ${runId}, COALESCE(MAX(ordinal), 0) + 1,
           ${currentAttempt}, 'active', '[]'::jsonb, ${workerGeneration}, NOW()
      FROM run_turns WHERE run_id = ${runId}
    RETURNING id, run_id, ordinal, execution_generation
  `));
  const turn = turnRows[0];
  if (!turn) return null;

  const inputRows = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT id, run_id, input_seq, message_id, kind, status, assigned_turn_id
      FROM run_inputs
     WHERE run_id = ${runId} AND status = 'pending'
     ORDER BY input_seq
     LIMIT ${limit}
     FOR UPDATE OF run_inputs SKIP LOCKED
  `));
  if (inputRows.length === 0) {
    await tx.execute(sql`DELETE FROM run_turns WHERE id = ${turnId}::uuid`);
    return null;
  }
  // A sleep is a maximum wait for the next input, not a persistent watchdog.
  // Retire it in the same transaction that accepts that input as a new turn.
  // This deliberately runs after the existing-turn recovery return above: a
  // replacement worker resuming the same turn must not cancel a sleep that the
  // still-active turn just armed.
  await tx.execute(sql`
    UPDATE run_timers SET status = 'cancelled'
     WHERE run_id = ${runId} AND status = 'pending' AND kind = 'sleep'
  `);
  await tx.execute(sql`UPDATE agent_runs SET park_reason = NULL, result = NULL WHERE id = ${runId}`);
  const ids = inputRows.map((row) => String(row.id));
  await tx.execute(sql`
    UPDATE run_inputs
       SET status = 'assigned', assigned_turn_id = ${turnId}::uuid, assigned_at = NOW()
     WHERE id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])
  `);
  const manifest = inputRows.map(row => ({ ...asInput(row), status: "assigned" as const, turnId }));
  await tx.execute(sql`
    UPDATE run_turns
       SET input_manifest = ${JSON.stringify(manifest)}::jsonb
     WHERE id = ${turnId}::uuid
  `);
  return {
    id: turnId,
    runId,
    ordinal: asInt(turn.ordinal),
    executionGeneration: asInt(turn.execution_generation),
    inputs: manifest,
  };
}

export type CompleteRunTurn = {
  turnId: string;
  runId: number;
  workerGeneration: number;
  instanceId: string;
  expectedWorkerScope?: string | null;
  checkpoint?: unknown;
  inputIds?: string[];
  resumeTokenBefore?: string | null;
  resumeTokenAfter?: string | null;
};

/** Fence and complete a turn, then mark exactly its manifest inputs complete. */
export async function completeRunTurnTx(tx: RunInputsTx, input: CompleteRunTurn): Promise<boolean> {
  const owner = rows<Record<string, unknown>>(await tx.execute(sql`SELECT id, attempt, worker_scope FROM agent_runs WHERE id = ${input.runId} FOR UPDATE`))[0];
  if (!owner || (input.expectedWorkerScope !== undefined && owner.worker_scope !== input.expectedWorkerScope)) return false;
  const turn = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT state, attempt, execution_generation, input_manifest FROM run_turns
    WHERE id = ${input.turnId}::uuid AND run_id = ${input.runId} FOR UPDATE
  `))[0];
  // A late receipt from a failed attempt must never complete inputs belonging
  // to a corrective attempt. The turn row remains available as an immutable
  // audit receipt, but its terminal transition is fenced by the run attempt.
  if (!turn || asInt(turn.attempt ?? 1) !== asInt(owner.attempt ?? 1) || Number(turn.execution_generation) !== input.workerGeneration) return false;
  const manifest = (typeof turn.input_manifest === "string" ? JSON.parse(turn.input_manifest) : turn.input_manifest) as RunInputRef[];
  const expected = manifest.map(ref => ref.id);
  if (!input.inputIds || expected.length !== input.inputIds.length || expected.some((id, index) => id !== input.inputIds![index])) {
    throw new Error(`Turn ${input.turnId} receipt manifest does not match assigned inputs`);
  }
  if (turn.state === 'completed') return false;
  if (!['active', 'running'].includes(String(turn.state))) return false;
  await tx.execute(sql`
    UPDATE run_turns SET state = 'completed', checkpoint = ${JSON.stringify(input.checkpoint ?? null)}::jsonb,
      backend_resume_before = ${input.resumeTokenBefore ?? null},
      backend_resume_after = ${input.resumeTokenAfter ?? null}, completed_at = NOW()
    WHERE id = ${input.turnId}::uuid
  `);
  const completed = rows(await tx.execute(sql`
    UPDATE run_inputs SET status = 'completed', completed_at = NOW()
    WHERE run_id = ${input.runId} AND assigned_turn_id = ${input.turnId}::uuid AND status = 'assigned'
    RETURNING id
  `));
  if (completed.length !== expected.length) throw new Error(`Turn ${input.turnId} assigned inputs changed`);
  return true;
}

export async function completeRunTurn(input: CompleteRunTurn): Promise<boolean> {
  return db.transaction((tx) => completeRunTurnTx(tx, input));
}

/** Materialize an existing inbox delivery into one typed event message/input. */
export async function materializeInboxEventsTx(tx: RunInputsTx, runId: number, limit = 32): Promise<RunInputRef[]> {
  const target = rows<Record<string, unknown>>(await tx.execute(sql`SELECT status FROM agent_runs WHERE id = ${runId} FOR UPDATE`))[0];
  if (!target || ['cancelled','closed','completed','failed','budget_exhausted'].includes(String(target.status))) {
    if (target) {
      await tx.execute(sql`UPDATE inbox_events SET status = 'superseded', error_reason = 'target_terminal' WHERE target_run_id = ${runId} AND status = 'pending'`);
    }
    return [];
  }
  await discardUnsubscribedEventsTx(tx, runId);
  const deliveries = rows<Record<string, unknown>>(await tx.execute(sql`
    SELECT i.id, i.source_event_id, i.type, i.payload, i.source_kind, i.source_id, i.attempt, i.created_at,
           e.source_run_id, e.revision, e.event_type, e.schema_version, e.occurred_at, e.payload AS event_payload
      FROM inbox_events i LEFT JOIN run_source_events e ON e.id = i.source_event_id
     WHERE target_run_id = ${runId} AND status = 'pending'
       AND type NOT IN ('run.cancel_requested', 'run.budget_exhausted')
       AND ${admittedInboxEvent(sql`i`)}
     ORDER BY i.id LIMIT ${limit} FOR UPDATE OF i SKIP LOCKED
  `));
  const out: RunInputRef[] = [];
  for (const delivery of deliveries) {
    let messageRows: Record<string, unknown>[];
    {
      messageRows = rows<Record<string, unknown>>(await tx.execute(sql`
      INSERT INTO agent_messages (run_id, role, content, event_delivery_id, created_at)
      VALUES (${runId}, 'system', ${JSON.stringify([{
        type: 'run_event', schema_version: Number(delivery.schema_version ?? 1), delivery_id: String(delivery.id),
        event_id: delivery.source_event_id ?? null, event_type: String(delivery.event_type ?? delivery.type),
        occurred_at: delivery.occurred_at ?? delivery.created_at,
        source: { run_id: delivery.source_run_id ?? null, revision: delivery.revision ?? null, attempt: delivery.attempt ?? null },
        payload: delivery.event_payload ?? delivery.payload,
      }])}, ${Number(delivery.id)}, COALESCE(${delivery.created_at}::timestamptz, NOW()))
      ON CONFLICT (event_delivery_id) WHERE event_delivery_id IS NOT NULL DO NOTHING
      RETURNING id
    `));
    }
    if (!messageRows.length) {
      // A previous materialization may have committed before an inbox retry.
      messageRows = rows<Record<string, unknown>>(await tx.execute(sql`SELECT id FROM agent_messages WHERE event_delivery_id = ${Number(delivery.id)} LIMIT 1`));
      if (!messageRows[0]) throw new Error(`Missing materialized delivery ${delivery.id}`);
    }
    const messageId = asInt(messageRows[0]?.id);
    if (!messageId) continue;
    const ref = await enqueueMessageTx(tx, { runId, messageId, kind: "event" });
    await tx.execute(sql`UPDATE inbox_events SET status = 'injected', injected_at = NOW() WHERE id = ${delivery.id}`);
    out.push(ref);
  }
  return out;
}

/** Bootstrap helper used by the channel snapshot. Materialization and turn
 * claiming share one transaction so a worker never receives a manifest for
 * inputs which were not durably queued. */
export async function materializeAndClaimRunTurn(
  runId: number,
  workerGeneration = 1,
  limit = 32,
): Promise<ClaimedRunTurn | null> {
  return db.transaction(async (tx) => {
    await materializeInboxEventsTx(tx, runId, limit);
    return claimRunTurn(tx, runId, workerGeneration, limit);
  });
}
