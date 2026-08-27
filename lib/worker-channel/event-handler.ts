// lib/worker-channel/event-handler.ts
//
// The control-plane side of plan section 14 (14.1–14.3): the serial, per-run
// handler for semantic worker events delivered over the WebSocket channel. It
// is wired as `connectRun`'s `onEvent`, so every accepted worker event is
// applied through this switch.
//
// Invariant: this runs INSIDE `applyWorkerEvent`'s transaction (the two-argument
// handler form). Every durable effect uses the passed `tx` so the effect and the
// event receipt commit atomically — a worker event is never applied twice and
// never lands a half write. Any command the handler enqueues (`run.commit`) is
// persisted with `persistCommandTx`, NOT `persistCommand`: the latter opens its
// own transaction and would deadlock against the locks this one already holds.
//
// Terminal handling is idempotent by construction: a replayed event with the
// same envelope id never re-enters this handler (the receipt layer short-circuits
// and re-returns the prior commit command id). A DIFFERENT event that arrives
// after a conflicting terminal outcome already won enqueues `run.commit` with the
// authoritative outcome and `accepted: false`.

import { and, eq, notInArray } from "drizzle-orm";
import { agentEvents, agentMessages, agentSessions, runTimers } from "../../db/schema";
import {
  LEASE_STATUSES,
  TERMINAL_STATUSES,
  buildStatusEventValues,
  coerceRunStatus,
  type SessionStatus,
} from "../run-state";
import { WORKER_LOG_MAX_CHARS } from "../runner/worker-log-store";
import {
  afterWorkerEventCommit,
  persistCommandTx,
  type WorkerChannelTransaction,
  type WorkerEventFrame,
} from "./repository";
import type {
  AgentEvent,
  RunCancelled,
  RunCheckpoint,
  RunCommit,
  RunFailed,
  RunFinished,
  RunPhase,
  TranscriptAppend,
  UsageSnapshot,
  WorkerLog,
} from "./protocol";

/** Observable phases that map onto a durable non-terminal run status. Phases
 * outside this map (e.g. "pushing") are recorded as a status event mirror but do
 * not move the status column. Terminal outcomes never arrive as a phase — they
 * come through run.finished/failed/cancelled. */
const PHASE_STATUS: Record<string, SessionStatus> = {
  preparing: "preparing",
  running: "running",
  // Clean chat-loop exit: the run returns to resumable-idle (the legacy
  // releaseClaim(..., idle) chat-exit landing). Never a lease status.
  idle: "idle",
};

const MAX_ERROR_CHARS = 8 * 1024;

/** Best-effort live-bus mirror for connected SSE browser clients. Loaded lazily
 * and DEFERRED until the enclosing worker-event transaction commits (BUG 2): these
 * handlers run inside applyWorkerEvent's open db.transaction, and emitting
 * synchronously — even via a cached dynamic import's microtask — fires before
 * COMMIT, so an SSE client that re-fetches on the pushed event can read pre-commit
 * state. afterWorkerEventCommit queues the emission to flush post-commit; outside a
 * transaction (a direct projection or a unit test) it returns false and we emit
 * immediately. A missing run bus is still a no-op. */
function emitLive(runId: number, type: string, payload: unknown): void {
  const emit = () =>
    void import("../runs")
      .then((runs) => runs.emitRunEvent(runId, type, payload))
      .catch(() => undefined);
  if (!afterWorkerEventCommit(emit)) emit();
}

function usageColumns(usage: UsageSnapshot | undefined): Record<string, unknown> {
  if (!usage) return {};
  const out: Record<string, unknown> = {};
  if (typeof usage.inputTokens === "number") out.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") out.outputTokens = usage.outputTokens;
  if (typeof usage.totalCostUsd === "number") out.totalCostUsd = usage.totalCostUsd;
  return out;
}

function normalizeError(error: string): string {
  const trimmed = error.trim();
  return trimmed.length > MAX_ERROR_CHARS ? trimmed.slice(0, MAX_ERROR_CHARS) : trimmed;
}

async function currentStatus(tx: WorkerChannelTransaction, runId: number): Promise<SessionStatus | null> {
  const rows = await tx
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId))
    .limit(1);
  return rows[0] ? coerceRunStatus(rows[0].status) : null;
}

// ── 14.1 Transcript and raw events ───────────────────────────────────────────

async function handleTranscriptAppend(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame
): Promise<void> {
  const { message } = frame.payload as TranscriptAppend;
  // Idempotency key is the envelope id: a redelivered transcript.append inserts
  // nothing the second time, and the persisted row's id is returned either way.
  const inserted = await tx
    .insert(agentMessages)
    .values({
      runId: frame.runId,
      role: message.role,
      content: JSON.stringify(message.content),
      idempotencyKey: frame.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: agentMessages.id });
  const row =
    inserted[0] ??
    (
      await tx
        .select({ id: agentMessages.id })
        .from(agentMessages)
        .where(and(eq(agentMessages.runId, frame.runId), eq(agentMessages.idempotencyKey, frame.id)))
        .limit(1)
    )[0];
  if (!row) throw new Error("transcript.append conflicted but no idempotent row was found");
  emitLive(frame.runId, "message", { id: row.id, role: message.role, content: message.content });
}

async function handleAgentEvent(tx: WorkerChannelTransaction, frame: WorkerEventFrame): Promise<void> {
  const { event } = frame.payload as AgentEvent;
  const type =
    event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
      ? (event as { type: string }).type
      : "agent";
  await tx.insert(agentEvents).values({
    sessionId: frame.runId,
    type,
    payload: JSON.stringify(event),
    createdAt: new Date(),
  });
  // Preserve the current browser notification behavior: surface the structured
  // event to any live SSE subscriber.
  emitLive(frame.runId, type, event);
}

async function handleWorkerLog(tx: WorkerChannelTransaction, frame: WorkerEventFrame): Promise<void> {
  const { entries, droppedCount } = frame.payload as WorkerLog;
  // Coalesce the batch into the bounded forensic tail. A dropped-count marker is
  // recorded inline so a truncated diagnostic stream is visible.
  const parts = entries.map((e) => (e.level ? `[${e.level}] ${e.message}` : e.message));
  if (droppedCount && droppedCount > 0) parts.push(`… (${droppedCount} log entries dropped)`);
  const batch = parts.join("\n");
  if (!batch) return;
  const rows = await tx
    .select({ log: agentSessions.workerLog })
    .from(agentSessions)
    .where(eq(agentSessions.id, frame.runId))
    .limit(1);
  const existing = rows[0]?.log ?? "";
  const combined = existing ? `${existing}\n${batch}` : batch;
  await tx
    .update(agentSessions)
    .set({ workerLog: combined.slice(-WORKER_LOG_MAX_CHARS) })
    .where(eq(agentSessions.id, frame.runId));
}

// ── 14.2 Phase and checkpoint ────────────────────────────────────────────────

async function handleRunPhase(tx: WorkerChannelTransaction, frame: WorkerEventFrame): Promise<void> {
  const { phase } = frame.payload as RunPhase;
  const target = PHASE_STATUS[phase];
  const status = await currentStatus(tx, frame.runId);
  // Monotonic lifecycle: never regress a run that already landed a terminal
  // outcome back into a live phase.
  if (status != null && TERMINAL_STATUSES.includes(status)) return;
  if (!target) {
    // Unknown phase: mirror it as a status event without moving the column.
    await tx.insert(agentEvents).values(buildStatusEventValues(frame.runId, (status ?? "running"), { phase }));
    return;
  }
  const set: Record<string, unknown> = { status: target };
  // Entering a lease status stamps the heartbeat in the same write (see the
  // db-transport.setStatus rationale): a fresh lease row must not look orphaned.
  if (LEASE_STATUSES.includes(target)) set.heartbeatAt = new Date();
  // Clean chat exit: the worker emits `idle` immediately before it exits (see
  // driveChatRun), so its claim must go in the same write — the legacy
  // releaseClaim(..., idle) landing. Without it isWorkerLive() keeps reporting a
  // live worker for HEARTBEAT_STALE_MS, so sendMessageToRun bridges the next
  // user message into a channel that is already closed instead of dispatching a
  // fresh worker. On sprites that channel is deliberately closed at idle, so the
  // message was never delivered at all (run 181).
  if (target === "idle") {
    set.workerScope = null;
    set.workerPid = null;
    set.heartbeatAt = null;
  }
  await tx
    .update(agentSessions)
    .set(set)
    .where(and(eq(agentSessions.id, frame.runId), notInArray(agentSessions.status, TERMINAL_STATUSES)));
  await tx.insert(agentEvents).values(buildStatusEventValues(frame.runId, target, { phase }));
  // Sprites: an open proxy tunnel is activity – close the channel when the run
  // goes idle so the sprite can hibernate. The next dispatchRun will re-dial.
  // Scheduled after commit so the channel.ack is flushed first.
  if (target === "idle") {
    const doClose = () => {
      void import("./registry").then((m) => m.maybeCloseSpritesChannel(frame.runId).catch(() => undefined));
    };
    // afterWorkerEventCommit queues post-commit; in tests without a tx it returns false
    const { afterWorkerEventCommit } = await import("./repository");
    if (!afterWorkerEventCommit(doClose)) doClose();
  }
}

async function handleRunCheckpoint(tx: WorkerChannelTransaction, frame: WorkerEventFrame): Promise<void> {
  const { sdkSessionId, metadata } = frame.payload as RunCheckpoint;
  const set: Record<string, unknown> = { sdkSessionId };
  // Allowlisted metadata only — the worker cannot patch arbitrary columns.
  if (metadata && typeof metadata === "object") {
    const meta = metadata as Record<string, unknown>;
    if (typeof meta.branch === "string") set.branch = meta.branch;
    if (typeof meta.worktreePath === "string") set.worktreePath = meta.worktreePath;
    if (typeof meta.prUrl === "string") set.prUrl = meta.prUrl;
    if (typeof meta.inputTokens === "number") set.inputTokens = meta.inputTokens;
    if (typeof meta.outputTokens === "number") set.outputTokens = meta.outputTokens;
    if (typeof meta.totalCostUsd === "number") set.totalCostUsd = meta.totalCostUsd;
  }
  await tx.update(agentSessions).set(set).where(eq(agentSessions.id, frame.runId));
  // Close the turn for the message relay. A chat worker emits exactly one
  // run.checkpoint per completed model turn (emitCheckpoint in
  // lib/worker-runtime/context.ts is called only on the chat drive paths), and a
  // chat run lands resumable-'idle' rather than a terminal status — so without a
  // per-turn marker relayRunStream never closes the POST /messages stream and the
  // composer stays stuck in its "sending" state, unable to send a follow-up. The
  // legacy in-process chat driver wrote this same turn_done event; it was lost when
  // the lightweight tier was retired and every chat moved onto the worker channel.
  // Written AFTER the turn's transcript rows persisted, so it sorts after the
  // reply and the relay yields the answer before closing.
  await tx.insert(agentEvents).values({
    sessionId: frame.runId,
    type: "turn_done",
    payload: JSON.stringify({}),
    createdAt: new Date(),
  });
}

// ── 14.3 Finish / fail / cancel ──────────────────────────────────────────────

/** Land a terminal outcome atomically and enqueue the authoritative run.commit.
 * A replayed finish event never re-enters this handler — the receipt layer
 * short-circuits it and re-returns the stored commit command id — so a fresh
 * command id per landing is correct. Returns that command id. */
async function landTerminal(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame,
  status: Extract<SessionStatus, "completed" | "failed" | "cancelled">,
  columns: Record<string, unknown>,
  commit: RunCommit
): Promise<{ resultCommandId: string }> {
  const written = await tx
    .update(agentSessions)
    .set({ status, ...columns })
    .where(and(eq(agentSessions.id, frame.runId), notInArray(agentSessions.status, TERMINAL_STATUSES)))
    .returning({ id: agentSessions.id });

  let commitPayload: RunCommit;
  if (written.length > 0) {
    // Both-or-neither: the status event and the timer cancellation share this tx.
    await tx.insert(agentEvents).values(
      buildStatusEventValues(frame.runId, status, { finishEventId: frame.id, ...(commit.error ? { error: commit.error } : {}) })
    );
    await tx
      .update(runTimers)
      .set({ status: "cancelled" })
      .where(and(eq(runTimers.runId, frame.runId), eq(runTimers.status, "pending")));
    commitPayload = { ...commit, finishEventId: frame.id, accepted: true } as RunCommit;
    emitLive(frame.runId, "status", { status });
  } else {
    // A conflicting terminal outcome already won. Do not overwrite it; enqueue a
    // commit that reports the authoritative outcome with accepted: false.
    const authoritative = (await currentStatus(tx, frame.runId)) ?? status;
    commitPayload = {
      ...commit,
      status: authoritative as RunCommit["status"],
      finishEventId: frame.id,
      accepted: false,
    } as RunCommit;
  }

  const row = await persistCommandTx(tx, {
    runId: frame.runId,
    instanceId: frame.instanceId,
    controllerEpoch: frame.controllerEpoch,
    type: "run.commit",
    payload: commitPayload,
  });
  return { resultCommandId: row.id };
}

async function handleRunFinished(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame
): Promise<{ resultCommandId: string }> {
  const payload = frame.payload as RunFinished;
  return landTerminal(
    tx,
    frame,
    "completed",
    { completedAt: new Date(), result: payload.result ?? null, ...(payload.prUrl != null ? { prUrl: payload.prUrl } : {}), ...usageColumns(payload.usage) },
    { status: "completed", result: payload.result, prUrl: payload.prUrl ?? null, usage: payload.usage }
  );
}

async function handleRunFailed(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame
): Promise<{ resultCommandId: string }> {
  const payload = frame.payload as RunFailed;
  const error = normalizeError(payload.error);
  return landTerminal(
    tx,
    frame,
    "failed",
    { completedAt: new Date(), error, ...(payload.result !== undefined ? { result: payload.result ?? null } : {}), ...usageColumns(payload.usage) },
    { status: "failed", error, result: payload.result, usage: payload.usage }
  );
}

async function handleRunCancelled(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame
): Promise<{ resultCommandId: string }> {
  const payload = frame.payload as RunCancelled;
  // Cancellation lands cancelled AND clears the worker claim in the same write.
  return landTerminal(
    tx,
    frame,
    "cancelled",
    { completedAt: new Date(), workerScope: null, workerPid: null },
    { status: "cancelled", error: payload.reason ?? null }
  );
}

/** The serial per-run event dispatcher wired as `connectRun`'s `onEvent`. */
export async function handleWorkerEvent(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame
): Promise<{ resultCommandId: string } | void> {
  switch (frame.type) {
    case "transcript.append":
      return handleTranscriptAppend(tx, frame);
    case "agent.event":
      return handleAgentEvent(tx, frame);
    case "worker.log":
      return handleWorkerLog(tx, frame);
    case "run.phase":
      return handleRunPhase(tx, frame);
    case "run.checkpoint":
      return handleRunCheckpoint(tx, frame);
    case "run.finished":
      return handleRunFinished(tx, frame);
    case "run.failed":
      return handleRunFailed(tx, frame);
    case "run.cancelled":
      return handleRunCancelled(tx, frame);
    default:
      // run.ready, tool.invoke, and any future event are handled elsewhere (or
      // are pure observations); acknowledge without a durable effect here.
      return undefined;
  }
}
