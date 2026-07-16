import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { db } from "../../db";
import { payloadSha256 } from "./codec";
import type { WorkerEvent } from "./protocol";

/**
 * The repository deliberately uses the physical channel table names here
 * instead of importing generated schema objects.  The channel schema and the
 * protocol are introduced by separate migration steps; keeping the table
 * writes in this module also makes it much harder for a worker-side module to
 * accidentally acquire database access.
 */

const HEARTBEAT_MS = 10_000;
const LEASE_MS = HEARTBEAT_MS * 3;

type RawRow = Record<string, unknown>;

/** A row in worker_channel_commands, with the application's camel-case names. */
export type CommandRow = {
  id: string;
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  seq: number;
  type: string;
  payload: unknown;
  state: "pending" | "acked";
  createdAt: Date;
  ackedAt: Date | null;
};

export type PersistCommandInput = {
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  type: string;
  payload: unknown;
  /** Normally generated here; accepting an id lets callers retry durably. */
  id?: string;
  /** Normally assigned here; accepting a sequence supports a prebuilt envelope. */
  seq?: number;
  createdAt?: Date;
};

export type ControllerLease = {
  runId: number;
  controllerId: string;
  epoch: number;
  /** Alias used by callers that use the protocol field name. */
  controllerEpoch: number;
  expiresAt: Date;
  /** Stable for the lifetime of this controller/epoch pair. */
  leaseId: string;
};

/** The subset of a post-handshake worker event used by the repository. */
export type WorkerEventFrame = WorkerEvent;

/** A transaction handle is passed to two-argument handlers for atomic effects. */
export type WorkerChannelTransaction = PgTransaction<any, any, any>;

export type WorkerEventHandlerResult =
  | string
  | { id: string }
  | { resultCommandId?: string | null; commandId?: string | null }
  | null
  | undefined
  | void;

export type WorkerEventHandler =
  | ((tx: WorkerChannelTransaction, frame: WorkerEventFrame) =>
      | Promise<WorkerEventHandlerResult>
      | WorkerEventHandlerResult)
  | ((frame: WorkerEventFrame) => Promise<WorkerEventHandlerResult> | WorkerEventHandlerResult);

export type ApplyResult = {
  duplicate: boolean;
  resultCommandId: string | null;
  /** Highest contiguous worker-lifetime sequence accepted for this channel. */
  lastAcceptedWorkerSeq: number;
  /** More concise alias for the same cursor. */
  contiguousSeq: number;
};

/** A live-bus emission deferred until the enclosing worker-event transaction
 * commits (BUG 2). */
type PostCommitEmission = () => void;

/** Per-transaction sink for live-bus emissions. `applyWorkerEvent` runs its whole
 * db.transaction inside this store; `event-handler.ts`'s `emitLive` registers
 * through {@link afterWorkerEventCommit}, and the emissions flush only AFTER the
 * transaction resolves (never on rollback). AsyncLocalStorage keeps this
 * re-entrancy-safe across concurrent per-run transactions — a module-level array
 * would let two interleaving applyWorkerEvent calls clobber each other's sink. */
const postCommitEmissions = new AsyncLocalStorage<PostCommitEmission[]>();

/**
 * Queue a live-bus emission to run after the current worker-event transaction
 * commits. Returns true when an enclosing `applyWorkerEvent` transaction is
 * active (the emission was deferred); false when there is none (the caller must
 * emit immediately — e.g. a direct projection or a unit test). This is the seam
 * that fixes BUG 2: emitting from inside `applyWorkerEvent`'s open transaction —
 * even via a cached dynamic import's microtask — fires before COMMIT, so an SSE
 * client that re-fetches on the pushed event can read pre-commit state.
 */
export function afterWorkerEventCommit(emit: PostCommitEmission): boolean {
  const store = postCommitEmissions.getStore();
  if (!store) return false;
  store.push(emit);
  return true;
}

export class WorkerChannelRepositoryError extends Error {
  readonly code: string;
  readonly closeCode?: number;
  readonly expectedSeq?: number;

  constructor(message: string, code: string, options: { closeCode?: number; expectedSeq?: number } = {}) {
    super(message);
    this.name = "WorkerChannelRepositoryError";
    this.code = code;
    this.closeCode = options.closeCode;
    this.expectedSeq = options.expectedSeq;
  }
}

type SqlExecutor = {
  execute(query: SQL): Promise<unknown>;
};

function rows<T extends RawRow = RawRow>(result: unknown): T[] {
  return (Array.isArray(result) ? result : []) as T[];
}

async function queryRows<T extends RawRow = RawRow>(executor: SqlExecutor, query: SQL): Promise<T[]> {
  return rows<T>(await executor.execute(query));
}

function numberValue(value: unknown, field: string): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid ${field} returned by Postgres`);
  return n;
}

function dateValue(value: unknown, field: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field} returned by Postgres`);
  return date;
}

function nullableDateValue(value: unknown, field: string): Date | null {
  return value == null ? null : dateValue(value, field);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // postgres.js normally decodes jsonb for us.  Returning an undecoded value
    // is still preferable to changing the durable payload on a legacy driver.
    return value;
  }
}

function commandRow(row: RawRow): CommandRow {
  return {
    id: String(row.id),
    runId: numberValue(row.run_id, "run_id"),
    instanceId: String(row.instance_id),
    controllerEpoch: numberValue(row.controller_epoch, "controller_epoch"),
    seq: numberValue(row.seq, "seq"),
    type: String(row.type),
    payload: jsonValue(row.payload),
    state: row.state === "acked" ? "acked" : "pending",
    createdAt: dateValue(row.created_at, "created_at"),
    ackedAt: nullableDateValue(row.acked_at, "acked_at"),
  };
}

function leaseId(runId: number, controllerId: string, epoch: number): string {
  return `${runId}:${controllerId}:${epoch}`;
}

function asDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return value;
}

/** Bind a Date into a raw SQL template as an explicitly-typed timestamptz.
 * postgres.js cannot pick a serializer for a bare Date parameter in a raw
 * `execute()` template (it falls back to the text serializer and throws), so
 * every date parameter is sent as an ISO string with an explicit cast. */
function ts(value: Date): SQL {
  return drizzleSql`${value.toISOString()}::timestamptz`;
}

function channelLockKey(runId: number, instanceId: string): string {
  return `${runId}:${instanceId}`;
}

async function lockChannel<T extends SqlExecutor>(tx: T, runId: number, instanceId: string): Promise<void> {
  // The advisory lock serializes command allocation, rebase, and event cursor
  // work even while the runner row is being replaced by provider code.
  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${channelLockKey(runId, instanceId)}))`
  );
}

async function lockRunner(tx: SqlExecutor, runId: number): Promise<RawRow> {
  const result = await queryRows(
    tx,
    drizzleSql`SELECT run_id FROM runner_instances WHERE run_id = ${runId} FOR UPDATE`
  );
  const row = result[0];
  if (!row) throw new Error(`Runner instance for run ${runId} was not found`);
  return row;
}

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "bigint") return input.toString();
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map((item) => (item === undefined ? null : normalize(item)));
    if (typeof input === "object") {
      const object = input as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        if (object[key] !== undefined) output[key] = normalize(object[key]);
      }
      return output;
    }
    return null;
  };

  return JSON.stringify(normalize(value));
}

/** Canonical payload digest used in worker-channel receipts. */
export function canonicalPayloadSha256(payload: unknown): string {
  return payloadSha256({ payload });
}

function handlerResultCommandId(result: WorkerEventHandlerResult): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;
  if ("resultCommandId" in result && result.resultCommandId) return result.resultCommandId;
  if ("commandId" in result && result.commandId) return result.commandId;
  if ("id" in result && result.id) return result.id;
  return null;
}

async function contiguousWorkerSeq(tx: SqlExecutor, runId: number, instanceId: string): Promise<number> {
  const result = await queryRows(
    tx,
    drizzleSql`
      SELECT worker_seq
      FROM worker_channel_receipts
      WHERE run_id = ${runId} AND instance_id = ${instanceId}
      ORDER BY worker_seq ASC
    `
  );

  let expected = 1;
  for (const row of result) {
    const seq = numberValue(row.worker_seq, "worker_seq");
    if (seq < expected) continue;
    if (seq !== expected) break;
    expected += 1;
  }
  return expected - 1;
}

async function listPendingCommandsTx(
  tx: SqlExecutor,
  runId: number,
  instanceId: string,
  epoch: number
): Promise<CommandRow[]> {
  const result = await queryRows(
    tx,
    drizzleSql`
      SELECT id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at, acked_at
      FROM worker_channel_commands
      WHERE run_id = ${runId}
        AND instance_id = ${instanceId}
        AND controller_epoch = ${epoch}
        AND state = 'pending'
      ORDER BY seq ASC
    `
  );
  return result.map(commandRow);
}

/** Reserve an instance identity and endpoint atomically and idempotently. */
export async function reserveChannelIdentity(
  runId: number,
  instanceId: string,
  endpoint: string
): Promise<void> {
  const updated = await queryRows(
    db,
    drizzleSql`
      UPDATE runner_instances
      SET channel_instance_id = ${instanceId}, channel_endpoint = ${endpoint}
      WHERE run_id = ${runId}
        AND (channel_instance_id IS NULL OR channel_instance_id = ${instanceId})
      RETURNING run_id
    `
  );
  if (updated.length) return;

  const existing = await queryRows(
    db,
    drizzleSql`SELECT channel_instance_id FROM runner_instances WHERE run_id = ${runId}`
  );
  if (!existing.length) throw new Error(`Runner instance for run ${runId} was not found`);
  throw new WorkerChannelRepositoryError(
    `Run ${runId} is already reserved for a different worker instance`,
    "INSTANCE_REPLACED",
    { closeCode: 4403 }
  );
}

export async function setChannelEndpoint(runId: number, instanceId: string, endpoint: string): Promise<void> {
  const updated = await queryRows(
    db,
    drizzleSql`
      UPDATE runner_instances
      SET channel_endpoint = ${endpoint}
      WHERE run_id = ${runId} AND channel_instance_id = ${instanceId}
      RETURNING run_id
    `
  );
  if (!updated.length) {
    throw new WorkerChannelRepositoryError(
      `Worker instance ${instanceId} is not registered for run ${runId}`,
      "INSTANCE_SCOPE_MISMATCH",
      { closeCode: 4403 }
    );
  }
}

/** Read the dial identity owned by a runner instance.  Keeping this lookup in
 * the repository prevents the connection manager from reaching around the
 * channel persistence boundary. */
export async function getChannelIdentity(
  runId: number,
): Promise<{ instanceId: string; endpoint: string } | null> {
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT channel_instance_id, channel_endpoint
      FROM runner_instances
      WHERE run_id = ${runId}
    `,
  );
  const row = result[0];
  if (!row || row.channel_instance_id == null || row.channel_endpoint == null) return null;
  return { instanceId: String(row.channel_instance_id), endpoint: String(row.channel_endpoint) };
}

/** One reconnectable channel: a runner instance that still has a dial identity
 * for a run that has not reached a terminal status. */
export type ChannelInstanceRow = {
  runId: number;
  instanceId: string;
  endpoint: string;
  status: string;
  workerScope: string | null;
  channelLastSeenAt: Date | null;
};

function channelInstanceRow(row: RawRow): ChannelInstanceRow {
  return {
    runId: numberValue(row.run_id, "run_id"),
    instanceId: String(row.channel_instance_id),
    endpoint: String(row.channel_endpoint),
    status: String(row.status),
    workerScope: row.worker_scope == null ? null : String(row.worker_scope),
    channelLastSeenAt: nullableDateValue(row.channel_last_seen_at, "channel_last_seen_at"),
  };
}

/**
 * Active worker channels a freshly booted (or hot-deployed) controller must
 * re-adopt: every runner instance that still carries a dial identity for a run
 * that has not reached a terminal status. The startup scan connects to each.
 */
export async function listReconnectableChannels(): Promise<ChannelInstanceRow[]> {
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT ri.run_id, ri.channel_instance_id, ri.channel_endpoint,
             ri.channel_last_seen_at, r.status, r.worker_scope
      FROM runner_instances ri
      JOIN agent_runs r ON r.id = ri.run_id
      WHERE ri.channel_instance_id IS NOT NULL
        AND ri.channel_endpoint IS NOT NULL
        AND r.status NOT IN ('completed', 'failed', 'cancelled', 'closed')
    `
  );
  return result.map(channelInstanceRow);
}

/**
 * Channels whose worker has gone silent past `staleBefore`: a run in a lease
 * status (turn in flight) whose channel_last_seen_at is null or older than the
 * cutoff. Stale detection keys off channel_last_seen_at — the channel's own
 * liveness clock — not a worker-issued heartbeat request.
 */
export async function listStaleChannelRuns(staleBefore: Date): Promise<ChannelInstanceRow[]> {
  const at = asDate(staleBefore, "staleBefore");
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT ri.run_id, ri.channel_instance_id, ri.channel_endpoint,
             ri.channel_last_seen_at, r.status, r.worker_scope
      FROM runner_instances ri
      JOIN agent_runs r ON r.id = ri.run_id
      WHERE ri.channel_instance_id IS NOT NULL
        AND ri.channel_endpoint IS NOT NULL
        AND r.status IN ('running', 'preparing')
        AND (ri.channel_last_seen_at IS NULL OR ri.channel_last_seen_at < ${ts(at)})
    `
  );
  return result.map(channelInstanceRow);
}

/**
 * Abandon a worker instance so the run can be re-dispatched onto a fresh one
 * (protocol-mismatch replacement). Clears the worker claim, heartbeat, controller
 * lease, and the stale channel identity/endpoint so a new dispatch's
 * reserveChannelIdentity can claim the row. Leaves the run's status untouched —
 * dispatchRun re-claims it.
 */
export async function releaseChannelForReplacement(runId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`
        UPDATE agent_runs
        SET worker_scope = NULL, worker_pid = NULL, heartbeat_at = NULL
        WHERE id = ${runId}
      `
    );
    await tx.execute(
      drizzleSql`
        UPDATE runner_instances
        SET channel_instance_id = NULL, channel_endpoint = NULL,
            channel_connected_at = NULL, channel_last_seen_at = NULL,
            controller_id = NULL, controller_lease_expires_at = NULL
        WHERE run_id = ${runId}
      `
    );
  });
}

/** Clear a run's worker claim and controller lease as part of terminal channel
 * teardown. Idempotent; leaves status untouched (the terminal landing owns it). */
export async function clearChannelClaim(runId: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`
        UPDATE agent_runs
        SET worker_scope = NULL, worker_pid = NULL
        WHERE id = ${runId}
      `
    );
    await tx.execute(
      drizzleSql`
        UPDATE runner_instances
        SET controller_id = NULL, controller_lease_expires_at = NULL
        WHERE run_id = ${runId}
      `
    );
  });
}

export async function acquireControllerLease(
  runId: number,
  controllerId: string,
  now: Date
): Promise<ControllerLease> {
  const at = asDate(now, "now");
  return db.transaction(async (tx) => {
    const current = await queryRows(
      tx,
      drizzleSql`
        SELECT controller_epoch, controller_id, controller_lease_expires_at
        FROM runner_instances
        WHERE run_id = ${runId}
        FOR UPDATE
      `
    );
    if (!current.length) throw new Error(`Runner instance for run ${runId} was not found`);

    const row = current[0];
    const currentEpoch = numberValue(row.controller_epoch ?? 0, "controller_epoch");
    const currentController = row.controller_id == null ? null : String(row.controller_id);
    const expires = nullableDateValue(row.controller_lease_expires_at, "controller_lease_expires_at");
    const sameLiveLease = currentController === controllerId && expires != null && expires.getTime() > at.getTime();
    const epoch = sameLiveLease ? currentEpoch : currentEpoch + 1;
    const expiresAt = new Date(at.getTime() + LEASE_MS);

    await tx.execute(
      drizzleSql`
        UPDATE runner_instances
        SET controller_epoch = ${epoch},
            controller_id = ${controllerId},
            controller_lease_expires_at = ${ts(expiresAt)}
        WHERE run_id = ${runId}
      `
    );

    return {
      runId,
      controllerId,
      epoch,
      controllerEpoch: epoch,
      expiresAt,
      leaseId: leaseId(runId, controllerId, epoch),
    };
  });
}

export async function renewControllerLease(
  runId: number,
  controllerId: string,
  epoch: number,
  now: Date
): Promise<boolean> {
  const at = asDate(now, "now");
  const expiresAt = new Date(at.getTime() + LEASE_MS);
  const updated = await queryRows(
    db,
    drizzleSql`
      UPDATE runner_instances
      SET controller_lease_expires_at = ${ts(expiresAt)}
      WHERE run_id = ${runId}
        AND controller_id = ${controllerId}
        AND controller_epoch = ${epoch}
        AND controller_lease_expires_at > ${ts(at)}
      RETURNING run_id
    `
  );
  return updated.length > 0;
}

export async function releaseControllerLease(runId: number, controllerId: string, epoch: number): Promise<void> {
  await queryRows(
    db,
    drizzleSql`
      UPDATE runner_instances
      SET controller_id = NULL, controller_lease_expires_at = NULL
      WHERE run_id = ${runId} AND controller_id = ${controllerId} AND controller_epoch = ${epoch}
      RETURNING run_id
    `
  );
}

export async function markChannelConnected(runId: number, instanceId: string, now: Date): Promise<void> {
  const at = asDate(now, "now");
  // Channel activity is the sole liveness signal after the HTTP heartbeat is
  // gone: bump both channel_last_seen_at (the channel-stale clock) and the run's
  // heartbeat_at (the shared orphan-reaper clock) in ONE transaction so the two
  // never diverge.
  const updated = await db.transaction(async (tx) => {
    const affected = await queryRows(
      tx,
      drizzleSql`
        UPDATE runner_instances
        SET channel_connected_at = ${ts(at)}, channel_last_seen_at = ${ts(at)}
        WHERE run_id = ${runId} AND channel_instance_id = ${instanceId}
        RETURNING run_id
      `
    );
    if (affected.length) await stampRunHeartbeatTx(tx, runId, at);
    return affected;
  });
  if (!updated.length) {
    throw new WorkerChannelRepositoryError(
      `Worker instance ${instanceId} is not registered for run ${runId}`,
      "INSTANCE_SCOPE_MISMATCH",
      { closeCode: 4403 }
    );
  }
}

export async function touchChannel(
  runId: number,
  instanceId: string,
  controllerId: string,
  epoch: number,
  now: Date
): Promise<boolean> {
  const at = asDate(now, "now");
  const expiresAt = new Date(at.getTime() + LEASE_MS);
  // Renew the channel-stale clock, the controller lease, and the run heartbeat
  // together. Both timestamps advance atomically so the reaper's channel-stale
  // check (channel_last_seen_at) and the shared orphan reaper (heartbeat_at)
  // agree about liveness.
  return db.transaction(async (tx) => {
    const updated = await queryRows(
      tx,
      drizzleSql`
        UPDATE runner_instances
        SET channel_last_seen_at = ${ts(at)}, controller_lease_expires_at = ${ts(expiresAt)}
        WHERE run_id = ${runId}
          AND channel_instance_id = ${instanceId}
          AND controller_id = ${controllerId}
          AND controller_epoch = ${epoch}
          AND controller_lease_expires_at > ${ts(at)}
        RETURNING run_id
      `
    );
    if (!updated.length) return false;
    await stampRunHeartbeatTx(tx, runId, at);
    return true;
  });
}

/** Advance a run's shared heartbeat_at from channel activity, but only while it
 * is still in a live (non-terminal) status — a terminal run's liveness must not
 * be resurrected by a late channel frame. */
async function stampRunHeartbeatTx(tx: SqlExecutor, runId: number, at: Date): Promise<void> {
  await tx.execute(
    drizzleSql`
      UPDATE agent_runs
      SET heartbeat_at = ${ts(at)}
      WHERE id = ${runId}
        AND status NOT IN ('completed', 'failed', 'cancelled', 'closed')
    `
  );
}

/** Core command insert shared by the standalone and tx-scoped variants. The
 * caller must already hold the channel advisory lock and the runner row lock so
 * that sequence allocation is serialized. */
async function insertCommandCore(tx: SqlExecutor, input: PersistCommandInput): Promise<CommandRow> {
  const commandId = input.id ?? randomUUID();
  const existing = await queryRows(
    tx,
    drizzleSql`
      SELECT id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at, acked_at
      FROM worker_channel_commands
      WHERE id = ${commandId}
    `
  );
  if (existing.length) {
    const row = commandRow(existing[0]);
    if (
      row.runId !== input.runId ||
      row.instanceId !== input.instanceId ||
      row.controllerEpoch !== input.controllerEpoch ||
      row.type !== input.type ||
      canonicalJson(row.payload) !== canonicalJson(input.payload)
    ) {
      throw new WorkerChannelRepositoryError(
        `Command ${commandId} was replayed with different contents`,
        "COMMAND_ID_MISMATCH",
        { closeCode: 4403 }
      );
    }
    return row;
  }

  const maxRows = await queryRows(
    tx,
    drizzleSql`
      SELECT COALESCE(MAX(seq), 0) AS max_seq
      FROM worker_channel_commands
      WHERE run_id = ${input.runId}
        AND instance_id = ${input.instanceId}
        AND controller_epoch = ${input.controllerEpoch}
    `
  );
  const nextSeq = numberValue(maxRows[0]?.max_seq ?? 0, "max_seq") + 1;
  const seq = input.seq ?? nextSeq;
  if (!Number.isSafeInteger(seq) || seq <= 0 || seq !== nextSeq) {
    throw new WorkerChannelRepositoryError(
      `Command sequence ${seq} is not the next sequence ${nextSeq} for epoch ${input.controllerEpoch}`,
      "COMMAND_SEQUENCE_CONFLICT"
    );
  }

  const createdAt = input.createdAt == null ? new Date() : asDate(input.createdAt, "createdAt");
  const inserted = await queryRows(
    tx,
    drizzleSql`
      INSERT INTO worker_channel_commands
        (id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at)
      VALUES
        (${commandId}, ${input.runId}, ${input.instanceId}, ${input.controllerEpoch}, ${seq},
         ${input.type}, ${JSON.stringify(input.payload)}::jsonb, 'pending', ${ts(createdAt)})
      RETURNING id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at, acked_at
    `
  );
  if (!inserted.length) throw new Error("Postgres did not return the persisted worker command");
  return commandRow(inserted[0]);
}

export async function persistCommand(input: PersistCommandInput): Promise<CommandRow> {
  if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch <= 0) {
    throw new TypeError("controllerEpoch must be a positive integer");
  }

  return db.transaction(async (tx) => {
    await lockChannel(tx, input.runId, input.instanceId);
    await lockRunner(tx, input.runId);
    return insertCommandCore(tx, input);
  });
}

/**
 * Persist a command inside an already-open channel transaction — the variant
 * used by the worker event handler, which runs inside `applyWorkerEvent`'s
 * transaction. That transaction already holds the channel advisory lock and the
 * runner row lock; calling {@link persistCommand} here would open a SECOND
 * transaction that blocks forever waiting for those same locks (a self
 * deadlock). This reuses the caller's `tx`, so the command insert and the event
 * receipt commit atomically as one unit.
 */
export async function persistCommandTx(
  tx: WorkerChannelTransaction,
  input: PersistCommandInput
): Promise<CommandRow> {
  if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch <= 0) {
    throw new TypeError("controllerEpoch must be a positive integer");
  }
  return insertCommandCore(tx as unknown as SqlExecutor, input);
}

export async function rebasePendingCommands(
  runId: number,
  instanceId: string,
  newEpoch: number
): Promise<CommandRow[]> {
  if (!Number.isSafeInteger(newEpoch) || newEpoch <= 0) throw new TypeError("newEpoch must be a positive integer");

  return db.transaction(async (tx) => {
    await lockChannel(tx, runId, instanceId);
    await lockRunner(tx, runId);
    const pending = await queryRows(
      tx,
      drizzleSql`
        SELECT id
        FROM worker_channel_commands
        WHERE run_id = ${runId}
          AND instance_id = ${instanceId}
          AND controller_epoch < ${newEpoch}
          AND state = 'pending'
        ORDER BY created_at ASC, id ASC
      `
    );

    for (const [index, row] of pending.entries()) {
      await tx.execute(
        drizzleSql`
          UPDATE worker_channel_commands
          SET controller_epoch = ${newEpoch}, seq = ${index + 1}
          WHERE id = ${String(row.id)}
        `
      );
    }
    return listPendingCommandsTx(tx, runId, instanceId, newEpoch);
  });
}

export async function listPendingCommands(
  runId: number,
  instanceId: string,
  epoch: number
): Promise<CommandRow[]> {
  return listPendingCommandsTx(db, runId, instanceId, epoch);
}

/** Load a single persisted command by id (control-plane delivery of a command
 *  enqueued from within the worker-event handler, e.g. `run.commit`). */
export async function getCommand(id: string): Promise<CommandRow | null> {
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at, acked_at
      FROM worker_channel_commands
      WHERE id = ${id}
      LIMIT 1
    `
  );
  return result[0] ? commandRow(result[0]) : null;
}

/**
 * Read the authoritative allowed-tool set from the run's persisted `run.start`
 * command (plan section 15 rule 2). The start snapshot is the single source of
 * truth for what the agent may invoke; a `tool.invoke` naming anything outside
 * this list is rejected before the server tool registry is ever consulted.
 * Returns null when no `run.start` command has been persisted yet.
 */
export async function getRunStartPolicy(
  runId: number,
  instanceId: string
): Promise<{ allowedTools: string[] } | null> {
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT payload
      FROM worker_channel_commands
      WHERE run_id = ${runId} AND instance_id = ${instanceId} AND type = 'run.start'
      ORDER BY controller_epoch DESC, seq DESC
      LIMIT 1
    `
  );
  const row = result[0];
  if (!row) return null;
  const payload = jsonValue(row.payload) as { policy?: { allowedTools?: unknown } } | null;
  const allowed = payload?.policy?.allowedTools;
  return { allowedTools: Array.isArray(allowed) ? allowed.map(String) : [] };
}

/**
 * Persist the single `tool.result` command for a `tool.invoke` and link it into
 * that invocation's receipt, atomically (plan section 15 rules 3, 6, 7, 8).
 *
 * Idempotent by the invocation envelope id: if the receipt already carries a
 * `result_command_id`, the stored command is returned unchanged and the tool is
 * NEVER re-run — a duplicate invocation replays the exact prior result. The
 * command insert and the receipt link commit in one transaction so a result is
 * never exposed without its receipt.
 */
export async function persistToolResultCommand(input: {
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  invokeEventId: string;
  payload: unknown;
}): Promise<CommandRow> {
  if (!Number.isSafeInteger(input.controllerEpoch) || input.controllerEpoch <= 0) {
    throw new TypeError("controllerEpoch must be a positive integer");
  }
  return db.transaction(async (tx) => {
    await lockChannel(tx, input.runId, input.instanceId);
    await lockRunner(tx, input.runId);

    const receiptRows = await queryRows(
      tx,
      drizzleSql`
        SELECT result_command_id
        FROM worker_channel_receipts
        WHERE id = ${input.invokeEventId}
      `
    );
    const linked = receiptRows[0]?.result_command_id;
    if (linked != null) {
      const existing = await queryRows(
        tx,
        drizzleSql`
          SELECT id, run_id, instance_id, controller_epoch, seq, type, payload, state, created_at, acked_at
          FROM worker_channel_commands
          WHERE id = ${String(linked)}
        `
      );
      if (existing.length) return commandRow(existing[0]);
    }

    const command = await insertCommandCore(tx as unknown as SqlExecutor, {
      runId: input.runId,
      instanceId: input.instanceId,
      controllerEpoch: input.controllerEpoch,
      type: "tool.result",
      payload: input.payload,
    });
    await tx.execute(
      drizzleSql`
        UPDATE worker_channel_receipts
        SET result_command_id = ${command.id}
        WHERE id = ${input.invokeEventId}
      `
    );
    return command;
  });
}

/** A tool.invoke whose receipt committed but whose tool.result never did. */
export type OrphanedToolInvoke = {
  id: string;
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  seq: number;
  payload: unknown;
};

/**
 * Tool invocations stranded by a control-plane crash (BUG 1b): receipts for
 * `run/instance` whose `result_command_id` is still NULL and that carry a durable
 * `invoke_payload`. The reconnect sweep re-executes each so the agent's tool call
 * is not hung forever — the worker will not replay an already-acked invocation, so
 * nothing else retries it. Scoped to the reconnecting channel's run+instance.
 */
export async function listOrphanedToolInvokes(
  runId: number,
  instanceId: string
): Promise<OrphanedToolInvoke[]> {
  const result = await queryRows(
    db,
    drizzleSql`
      SELECT id, run_id, instance_id, controller_epoch, worker_seq, invoke_payload
      FROM worker_channel_receipts
      WHERE run_id = ${runId}
        AND instance_id = ${instanceId}
        AND type = 'tool.invoke'
        AND result_command_id IS NULL
        AND invoke_payload IS NOT NULL
      ORDER BY worker_seq ASC
    `
  );
  return result.map((row) => ({
    id: String(row.id),
    runId: numberValue(row.run_id, "run_id"),
    instanceId: String(row.instance_id),
    controllerEpoch: numberValue(row.controller_epoch, "controller_epoch"),
    seq: numberValue(row.worker_seq, "worker_seq"),
    payload: jsonValue(row.invoke_payload),
  }));
}

export async function ackCommandsThrough(
  runId: number,
  instanceId: string,
  epoch: number,
  seq: number,
  now: Date
): Promise<void> {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("seq must be a non-negative integer");
  const at = asDate(now, "now");
  await queryRows(
    db,
    drizzleSql`
      UPDATE worker_channel_commands
      SET state = 'acked', acked_at = ${ts(at)}
      WHERE run_id = ${runId}
        AND instance_id = ${instanceId}
        AND controller_epoch = ${epoch}
        AND state = 'pending'
        AND seq <= ${seq}
      RETURNING id
    `
  );
}

export async function getLastAcceptedWorkerSeq(runId: number, instanceId: string): Promise<number> {
  return contiguousWorkerSeq(db, runId, instanceId);
}

/**
 * Apply one worker event and its idempotency receipt in one transaction.
 *
 * Two-argument handlers receive the transaction and must use it for their
 * durable effect.  A one-argument handler is retained for simple projections
 * and tests; its result is still receipt-protected, but callers needing an
 * effect/receipt atomicity guarantee should use the two-argument form.
 */
export async function applyWorkerEvent(frame: WorkerEventFrame, handler: WorkerEventHandler): Promise<ApplyResult> {
  if (!frame.id || !frame.type || !frame.instanceId || !Number.isSafeInteger(frame.seq) || frame.seq <= 0) {
    throw new WorkerChannelRepositoryError("Malformed worker event envelope", "INVALID_WORKER_EVENT", {
      closeCode: 4403,
    });
  }
  const payloadHash = canonicalPayloadSha256(frame.payload);
  const emissions: PostCommitEmission[] = [];

  return postCommitEmissions.run(emissions, async () => {
    const result = await db.transaction(async (tx) => {
    await lockChannel(tx, frame.runId, frame.instanceId);
    await lockRunner(tx, frame.runId);

    const priorRows = await queryRows(
      tx,
      drizzleSql`
        SELECT id, run_id, instance_id, worker_seq, controller_epoch, type, payload_sha256, result_command_id
        FROM worker_channel_receipts
        WHERE id = ${frame.id}
      `
    );
    if (priorRows.length) {
      const prior = priorRows[0];
      const sameScope =
        numberValue(prior.run_id, "run_id") === frame.runId && String(prior.instance_id) === frame.instanceId;
      const sameEnvelope =
        sameScope &&
        numberValue(prior.worker_seq, "worker_seq") === frame.seq &&
        numberValue(prior.controller_epoch, "controller_epoch") === frame.controllerEpoch &&
        String(prior.type) === frame.type;
      if (!sameScope || !sameEnvelope || String(prior.payload_sha256) !== payloadHash) {
        throw new WorkerChannelRepositoryError(
          `Worker receipt ${frame.id} was replayed with different contents`,
          "RECEIPT_HASH_MISMATCH",
          { closeCode: 4403 }
        );
      }
      const cursor = await contiguousWorkerSeq(tx, frame.runId, frame.instanceId);
      return {
        duplicate: true,
        resultCommandId: prior.result_command_id == null ? null : String(prior.result_command_id),
        lastAcceptedWorkerSeq: cursor,
        contiguousSeq: cursor,
      };
    }

    const cursor = await contiguousWorkerSeq(tx, frame.runId, frame.instanceId);
    const expectedSeq = cursor + 1;
    if (frame.seq !== expectedSeq) {
      throw new WorkerChannelRepositoryError(
        `Worker sequence gap: expected ${expectedSeq}, received ${frame.seq}`,
        "WORKER_SEQUENCE_GAP",
        { expectedSeq }
      );
    }

    const handlerResult =
      handler.length >= 2
        ? await (handler as (tx: WorkerChannelTransaction, event: WorkerEventFrame) =>
            Promise<WorkerEventHandlerResult> | WorkerEventHandlerResult)(tx, frame)
        : await (handler as (event: WorkerEventFrame) =>
            Promise<WorkerEventHandlerResult> | WorkerEventHandlerResult)(frame);
    const resultCommandId = handlerResultCommandId(handlerResult);

    // Persist the raw payload ONLY for tool.invoke receipts. The reconnect sweep
    // (BUG 1b) re-executes an orphaned invocation — one whose receipt committed and
    // was acked, but whose tool.result was lost to a crash before it persisted —
    // and the worker never replays an already-acked event, so the control plane is
    // the only place the arguments still exist. Other event types keep the
    // hash-only receipt (transcript payloads can be up to 1 MiB).
    const invokePayload =
      frame.type === "tool.invoke"
        ? drizzleSql`${JSON.stringify(frame.payload)}::jsonb`
        : drizzleSql`NULL`;

    await tx.execute(
      drizzleSql`
        INSERT INTO worker_channel_receipts
          (id, run_id, instance_id, worker_seq, controller_epoch, type, payload_sha256, result_command_id, invoke_payload)
        VALUES
          (${frame.id}, ${frame.runId}, ${frame.instanceId}, ${frame.seq}, ${frame.controllerEpoch},
           ${frame.type}, ${payloadHash}, ${resultCommandId}, ${invokePayload})
      `
    );

    const nextCursor = await contiguousWorkerSeq(tx, frame.runId, frame.instanceId);
    return {
      duplicate: false,
      resultCommandId,
      lastAcceptedWorkerSeq: nextCursor,
      contiguousSeq: nextCursor,
    };
    });
    // Reached only when db.transaction resolves (a rollback rejects and skips
    // this): the effect is now durable, so flush the deferred live-bus emissions.
    // A client reacting to one of these events re-fetches committed state (BUG 2).
    for (const emit of emissions) {
      try {
        emit();
      } catch {
        /* live bus is best-effort */
      }
    }
    return result;
  });
}
