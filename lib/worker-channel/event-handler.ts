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

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { agentEvents, agentMessages, agentSessions, runTimers, tasks } from "../../db/schema";
import {
  LEASE_STATUSES,
  TERMINAL_STATUSES,
  buildStatusEventValues,
  coerceRunStatus,
  isFailedResult,
  resultPrUrl,
  type SessionStatus,
} from "../run-state";
import { WORKER_LOG_MAX_CHARS } from "../runner/worker-log-store";
import { buildTurnInputCommand, claimRunTurn, completeRunTurnTx, materializeInboxEventsTx, hasReadyRunInputsTx } from "../run-inputs";
import { hasOutstandingSupervisionTx } from "../run-event-subscriptions";
import { lockSourceTx, publishAttemptFinishedTx, publishSourceEventTx } from "../run-source-events";
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
  parked: "parked",
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

/**
 * report_result/raise are persisted before the worker emits its lifecycle
 * event.  The worker's terminal payload is often only a textual model
 * summary, so it must not replace that structured tool result. The terminal
 * payload is used when no structured tool result has been persisted.
 */
function terminalResult(
  payloadResult: unknown,
  storedResult: unknown
): unknown {
  if (storedResult !== null && typeof storedResult === "object") return storedResult;
  return payloadResult !== undefined ? payloadResult : storedResult ?? null;
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
  const versionRows = await tx.select({ deliveryVersion: agentSessions.deliveryVersion }).from(agentSessions).where(eq(agentSessions.id, frame.runId)).limit(1);
  const durableV2 = versionRows[0]?.deliveryVersion === 2;
  // Monotonic lifecycle: never regress a run that already landed a terminal
  // outcome back into a live phase.
  if (status != null && TERMINAL_STATUSES.includes(status)) return;
  if (!target) {
    // Unknown phase: mirror it as a status event without moving the column.
    await tx.insert(agentEvents).values(buildStatusEventValues(frame.runId, (status ?? "running"), { phase }));
    return;
  }
  const set: Record<string, unknown> = { status: target };
  // New generation-aware workers release their claim only after explicitly
  // acknowledging the post-checkpoint idle/parked decision.
  if ((target === "parked" || target === "idle") && durableV2) {
    set.workerScope = null;
  }
  // 'idle' no longer releases the claim: the worker lands idle BETWEEN turns
  // and keeps waiting chatIdleMs for the next `run.input` (driveChatRun). A
  // kept claim is what makes sendMessageToRun re-dial the living worker instead
  // of dispatching a second one (a second run.start is a protocol error). A
  // worker that did exit is observed dead (exited / replaced) by resolveLiveness
  // on the next message, and only then is the claim discarded — the run-181
  // failure mode (bridging into a closed channel) is guarded there, not here.
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

async function handleRunCheckpoint(tx: WorkerChannelTransaction, frame: WorkerEventFrame): Promise<{ resultCommandId: string } | void> {
  const { sdkSessionId, metadata, turnId, inputIds, workerGeneration, instanceId, checkpoint } = frame.payload as RunCheckpoint;
  if (turnId) await lockSourceTx(tx, frame.runId);
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

  // New workers send a durable turn receipt with the checkpoint.  Keep the
  // legacy checkpoint-only path above for old bundles, but never infer input
  // completion from transcript/message ordering.
  if (turnId) {
    const completed = await completeRunTurnTx(tx, {
      turnId,
      runId: frame.runId,
      workerGeneration: frame.workerGeneration ?? 1,
      instanceId: frame.instanceId,
      checkpoint: checkpoint ?? metadata,
      inputIds,
      resumeTokenAfter: sdkSessionId,
    });
    if (!completed) {
      throw new Error(`Stale or already completed turn receipt ${turnId}`);
    }
    const attemptRows = await tx.select({ attempt: agentSessions.attempt }).from(agentSessions).where(eq(agentSessions.id, frame.runId)).limit(1);
    await publishSourceEventTx(tx, {
      sourceRunId: frame.runId,
      attempt: attemptRows[0]?.attempt ?? 1,
      eventType: "run.turn_finished",
      logicalTurnId: turnId,
      workerGeneration: frame.workerGeneration ?? 1,
      producerKey: `turn:${turnId}:finished`,
      payload: { turn_id: turnId, input_ids: inputIds ?? [], summary: (checkpoint as { summary?: unknown } | undefined)?.summary ?? null },
    });

    afterWorkerEventCommit(() => { void import("../run-event-delivery").then(m => m.hintRunEventDelivery()).catch(() => undefined); });

    // The checkpoint is also the safe backend boundary. Decide the next
    // lifecycle action in this transaction so an acknowledged checkpoint can
    // never leave a worker waiting without a durable command.
    const lifecycle = (await tx.select().from(agentSessions).where(eq(agentSessions.id, frame.runId)).limit(1))[0];
    const persistedPark = lifecycle?.parkReason;
    const countRows = await tx.execute(sql`SELECT COUNT(*)::int AS count FROM run_turns WHERE run_id=${frame.runId} AND state='completed'`);
    const persistedBudget = lifecycle?.status === "budget_exhausted" || Boolean(lifecycle && (
      (lifecycle.budgetMaxTurns != null && Number(countRows[0]?.count ?? 0) >= lifecycle.budgetMaxTurns) ||
      (lifecycle.budgetMaxUsd != null && (lifecycle.totalCostUsd ?? 0) >= lifecycle.budgetMaxUsd) ||
      (lifecycle.budgetMaxSeconds != null && Date.now() >= lifecycle.startedAt.getTime() + lifecycle.budgetMaxSeconds * 1000)
    ));
    if (persistedBudget) return landTerminal(tx, frame, "budget_exhausted", { completedAt: new Date(), workerScope: null }, { status: "budget_exhausted" });
    if (lifecycle && TERMINAL_STATUSES.includes(lifecycle.status as SessionStatus)) {
      const command = await persistCommandTx(tx, { runId: frame.runId, instanceId: frame.instanceId, workerGeneration: frame.workerGeneration, controllerEpoch: frame.controllerEpoch,
        type: "run.commit", payload: { status: lifecycle.status, finishEventId: frame.id, accepted: false } });
      return { resultCommandId: command.id };
    }
    if (!persistedPark && !persistedBudget) await materializeInboxEventsTx(tx, frame.runId, 32);
    const next = persistedPark || persistedBudget ? null : await claimRunTurn(tx, frame.runId, frame.workerGeneration ?? 1, 32);
    let type: "run.input" | "run.park";
    let payload: Record<string, unknown>;
    if (next) {
      const ids = next.inputs.map((item) => item.messageId);
      const messages = ids.length
        ? await tx.select({ id: agentMessages.id, runId: agentMessages.runId, role: agentMessages.role, content: agentMessages.content }).from(agentMessages).where(inArray(agentMessages.id, ids))
        : [];
      type = "run.input";
      payload = {
        ...buildTurnInputCommand(next, messages.map((row) => ({ ...row, content: JSON.parse(row.content) })) as any),
      };
    } else {
      const outstanding = await hasOutstandingSupervisionTx(tx, frame.runId);
      const goalRow = await tx.select({ goal: agentSessions.goal }).from(agentSessions).where(eq(agentSessions.id, frame.runId)).limit(1);
      const isChat = goalRow[0]?.goal === "<chat>";
      if (isChat && lifecycle?.result && !outstanding && !persistedPark) {
        const status = isFailedResult(lifecycle.result) ? "failed" : "completed";
        return landTerminal(tx, frame, status, { completedAt: new Date(), workerScope: null }, { status, result: lifecycle.result });
      }
      const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
      const parkReason = persistedPark ?? (typeof meta.parkReason === "string" ? meta.parkReason : null);
      const budgetHit = persistedBudget || meta.budgetHit === true;
      type = "run.park";
      payload = budgetHit
        ? { reason: "budget_exhausted", action: "park" }
        : parkReason
        ? { reason: parkReason, action: "park" }
        : outstanding
        ? { reason: "waiting", action: "park" }
        : { reason: "turn_finished", action: isChat ? "idle" : "finalize" };
    }
    const command = await persistCommandTx(tx, {
      runId: frame.runId,
      instanceId: frame.instanceId,
      workerGeneration: frame.workerGeneration,
      controllerEpoch: frame.controllerEpoch,
      type,
      payload,
    });
    return { resultCommandId: command.id };
  }
}

// ── 14.3 Finish / fail / cancel ──────────────────────────────────────────────

/** Land a terminal outcome atomically and enqueue the authoritative run.commit.
 * A replayed finish event never re-enters this handler — the receipt layer
 * short-circuits it and re-returns the stored commit command id — so a fresh
 * command id per landing is correct. Returns that command id. */
async function landTerminal(
  tx: WorkerChannelTransaction,
  frame: WorkerEventFrame,
  status: Extract<SessionStatus, "completed" | "failed" | "cancelled" | "budget_exhausted">,
  columns: Record<string, unknown>,
  commit: RunCommit
): Promise<{ resultCommandId: string }> {
  // Match the publication lock ordering used by status writers: source
  // revision ownership is acquired before mutating the source run row.
  await lockSourceTx(tx, frame.runId);
  const [before] = await tx.select().from(agentSessions).where(eq(agentSessions.id, frame.runId)).for("update");
  if (status === "completed" && before?.deliveryVersion === 2 && !TERMINAL_STATUSES.includes(before.status as SessionStatus)) {
    await materializeInboxEventsTx(tx, frame.runId);
    if (await hasOutstandingSupervisionTx(tx, frame.runId) || await hasReadyRunInputsTx(tx, frame.runId)) {
      await tx.update(agentSessions).set({ ...columns, status: "parked", completedAt: null, workerScope: null, parkReason: "waiting" }).where(eq(agentSessions.id, frame.runId));
      await tx.insert(agentEvents).values(buildStatusEventValues(frame.runId, "parked"));
      const decision = await persistCommandTx(tx, {
        runId: frame.runId, instanceId: frame.instanceId, workerGeneration: frame.workerGeneration,
        controllerEpoch: frame.controllerEpoch, type: "run.commit",
        payload: { ...commit, status: "parked", accepted: false, finishEventId: frame.id },
      });
      emitLive(frame.runId, "status", { status: "parked" });
      return { resultCommandId: decision.id };
    }
  }
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
    const attemptRows = await tx
      .select({ attempt: agentSessions.attempt })
      .from(agentSessions)
      .where(eq(agentSessions.id, frame.runId))
      .limit(1);
    await publishAttemptFinishedTx(tx, {
      sourceRunId: frame.runId,
      attempt: attemptRows[0]?.attempt ?? 1,
      status,
      error: commit.error ?? null,
      result: (commit.result as Record<string, unknown> | null | undefined) ?? null,
      prUrl: commit.prUrl ?? null,
      workerGeneration: frame.workerGeneration,
    });
    afterWorkerEventCommit(() => { void import("../run-event-delivery").then(m => m.hintRunEventDelivery()).catch(() => undefined); });
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
    workerGeneration: frame.workerGeneration,
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
  const [stored] = await tx.select({
    result: agentSessions.result, prUrl: agentSessions.prUrl, taskPrUrl: tasks.prUrl,
  }).from(agentSessions)
    .leftJoin(tasks, eq(agentSessions.taskId, tasks.id))
    .where(eq(agentSessions.id, frame.runId));
  const result = terminalResult(payload.result, stored?.result);
  const status = result && isFailedResult(result) ? "failed" : "completed";
  // The agent reports its delivered PR through report_result. The worker
  // finalizer does no GitHub work and may have started before that PR existed.
  const prUrl = resultPrUrl(result) ?? payload.prUrl ?? stored?.prUrl ?? stored?.taskPrUrl ?? null;
  return landTerminal(
    tx,
    frame,
    status,
    { completedAt: new Date(), result, ...(prUrl != null ? { prUrl } : {}), ...usageColumns(payload.usage) },
    { status, result, prUrl, usage: payload.usage }
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
    { completedAt: new Date(), workerScope: null },
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
