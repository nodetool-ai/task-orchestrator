// __tests__/worker-channel-event-handler.test.ts
//
// Behavioral port of the semantic-write cases from the five HTTP-path suites
// named in plan section 14.4 — worker-transport-semantics, atomic-finalize,
// turn-end-state-transport, runs-claim-release, cross-process-cancel — onto the
// WebSocket channel event handler (lib/worker-channel/event-handler.ts). The
// originals are NOT touched: they still guard the live HTTP path until section
// 18. This file pins the equivalent semantics on the channel side:
//   • transcript.append is exactly-once by envelope id;
//   • run.phase moves the lease status monotonically and never regresses a
//     landed run;
//   • run.finished/failed/cancelled land atomically with their status event,
//     are idempotent, cancel pending timers, clear the worker claim on cancel,
//     and enqueue an authoritative run.commit (accepted:false on a conflict);
//   • the handler enqueues that commit through persistCommandTx WITHOUT
//     deadlocking against the transaction it already runs inside.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  agentEvents,
  agentMessages,
  agentSessions,
  inboxEvents,
  runEventDeliveryMatches,
  runEventSubscriptions,
  runSourceEvents,
  runTimers,
  runnerInstances,
  workerChannelCommands,
  workerChannelReceipts,
  runInputs,
  runTurns,
} from "../db/schema";
import { create } from "../lib/runs";
import {
  acquireControllerLease,
  ackCommandsThrough,
  applyWorkerEvent,
  markChannelConnected,
  persistCommand,
  persistCommandTx,
  persistWorkerIncarnation,
} from "../lib/worker-channel/repository";
import { handleWorkerEvent } from "../lib/worker-channel/event-handler";
import type { WorkerEvent } from "../lib/worker-channel/protocol";

const instanceId = "wi_0123456789abcdef0123456789abcdef";

async function newRun(): Promise<number> {
  const run = await create({ goal: "<implement>", defer: true });
  await db.insert(runnerInstances).values({
    runId: run.id,
    channelInstanceId: instanceId,
    channelEndpoint: "ws://127.0.0.1:8787/worker/channel",
  });
  return run.id;
}

let seqByRun = new Map<number, number>();
function nextSeq(runId: number): number {
  const seq = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, seq);
  return seq;
}

function makeFrame(
  runId: number,
  type: WorkerEvent["type"],
  payload: unknown,
  opts: { id?: string; seq?: number; workerGeneration?: number } = {}
): WorkerEvent {
  return {
    v: 1,
    type,
    id: opts.id ?? randomUUID(),
    runId,
    instanceId,
    ...(opts.workerGeneration === undefined ? {} : { workerGeneration: opts.workerGeneration }),
    controllerEpoch: 1,
    seq: opts.seq ?? nextSeq(runId),
    sentAt: new Date().toISOString(),
    payload,
  } as WorkerEvent;
}

async function apply(frame: WorkerEvent) {
  return applyWorkerEvent(frame, handleWorkerEvent);
}

async function waitForCond(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met within timeout");
}

async function runStatus(runId: number): Promise<string> {
  const rows = await db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, runId));
  return rows[0]!.status;
}

async function statusEvents(runId: number, status: string): Promise<number> {
  const rows = await db
    .select({ payload: agentEvents.payload })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "status")));
  return rows.filter((r) => {
    try {
      return (JSON.parse(r.payload) as { status?: string }).status === status;
    } catch {
      return false;
    }
  }).length;
}

async function commits(runId: number): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const rows = await db
    .select({ id: workerChannelCommands.id, payload: workerChannelCommands.payload })
    .from(workerChannelCommands)
    .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "run.commit")));
  return rows.map((r) => ({ id: r.id, payload: r.payload as Record<string, unknown> }));
}

beforeEach(() => {
  seqByRun = new Map();
});

afterEach(async () => {
  await db.delete(runEventDeliveryMatches);
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(agentSessions);
});

// ── 14.1 transcript.append (port: worker-transport-semantics idempotency) ─────

describe("transcript.append", () => {
  it("persists one message and is a no-op on a redelivered envelope id", async () => {
    const runId = await newRun();
    const id = randomUUID();
    const payload = { message: { id: 1, role: "agent", content: [{ type: "text", text: "hello" }] } };
    const frame = makeFrame(runId, "transcript.append", payload, { id, seq: 1 });

    const first = await apply(frame);
    const second = await apply(frame); // same id + seq → receipt short-circuit

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    const rows = await db.select().from(agentMessages).where(eq(agentMessages.runId, runId));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("agent");
    expect(rows[0].idempotencyKey).toBe(id);
  });

  it("rejects a stale-generation frame before invoking its handler", async () => {
    const runId = await newRun();
    await db
      .update(runnerInstances)
      .set({ workerGeneration: 2 })
      .where(eq(runnerInstances.runId, runId));
    const handler = vi.fn(async () => undefined);
    const frame = makeFrame(runId, "transcript.append", {
      message: { id: 1, role: "agent", content: [{ type: "text", text: "stale" }] },
    }, { workerGeneration: 1 });

    await expect(applyWorkerEvent(frame, handler)).rejects.toMatchObject({
      code: "GENERATION_SCOPE_MISMATCH",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(
      await db.select().from(workerChannelReceipts).where(eq(workerChannelReceipts.runId, runId)),
    ).toHaveLength(0);
  });

  it("cannot let a delayed old incarnation observation overwrite the current epoch", async () => {
    const runId = await newRun();
    const oldLease = await acquireControllerLease(runId, "controller-old", new Date("2026-09-08T10:00:00Z"));
    expect(await persistWorkerIncarnation(
      runId,
      instanceId,
      "old-process",
      1,
      oldLease.controllerId,
      oldLease.epoch,
    )).toBe(true);

    const newLease = await acquireControllerLease(runId, "controller-new", new Date("2026-09-08T10:00:01Z"));
    expect(newLease.epoch).toBeGreaterThan(oldLease.epoch);
    expect(await persistWorkerIncarnation(
      runId,
      instanceId,
      "late-old-process",
      1,
      oldLease.controllerId,
      oldLease.epoch,
    )).toBe(false);
    expect(await persistWorkerIncarnation(
      runId,
      instanceId,
      "new-process",
      1,
      newLease.controllerId,
      newLease.epoch,
    )).toBe(true);

    const [row] = await db
      .select({ workerIncarnation: runnerInstances.workerIncarnation })
      .from(runnerInstances)
      .where(eq(runnerInstances.runId, runId));
    expect(row.workerIncarnation).toBe("new-process");
  });

  it("hands a Sprite claim to the provider scope only after the matching hello", async () => {
    const runId = await newRun();
    const provisioningScope = `server-claim-${runId}`;
    const spriteName = `to-run-${runId}`;
    await db.update(agentSessions)
      .set({ status: "running", workerScope: provisioningScope })
      .where(eq(agentSessions.id, runId));
    await db.update(runnerInstances)
      .set({
        provider: "sprites",
        spriteName,
        workerGeneration: 2,
        channelInstanceId: instanceId,
        controllerId: "controller-1",
        controllerEpoch: 1,
      })
      .where(eq(runnerInstances.runId, runId));

    // A stale/competing hello may mark the generation only when its captured
    // provisioning claim still matches; it must not steal the run scope.
    await expect(markChannelConnected(runId, instanceId, new Date(), 2, "controller-1", 1, "other-claim"))
      .rejects.toMatchObject({ code: "INSTANCE_SCOPE_MISMATCH" });
    const [stillProvisioning] = await db.select({ workerScope: agentSessions.workerScope })
      .from(agentSessions).where(eq(agentSessions.id, runId));
    expect(stillProvisioning.workerScope).toBe(provisioningScope);

    await markChannelConnected(runId, instanceId, new Date(), 2, "controller-1", 1, provisioningScope);
    const [promoted] = await db.select({ workerScope: agentSessions.workerScope })
      .from(agentSessions).where(eq(agentSessions.id, runId));
    expect(promoted.workerScope).toBe(spriteName);
  });

  it("does not let a stale-generation acknowledgement ack current commands", async () => {
    const runId = await newRun();
    await db
      .update(runnerInstances)
      .set({ workerGeneration: 2 })
      .where(eq(runnerInstances.runId, runId));
    const command = await persistCommand({
      runId,
      instanceId,
      workerGeneration: 2,
      controllerEpoch: 1,
      type: "run.input",
      payload: { messages: [] },
    });

    await expect(
      ackCommandsThrough(runId, instanceId, 1, command.seq, new Date(), 1),
    ).rejects.toMatchObject({ code: "GENERATION_SCOPE_MISMATCH" });
    const [stillPending] = await db
      .select({ state: workerChannelCommands.state })
      .from(workerChannelCommands)
      .where(eq(workerChannelCommands.id, command.id));
    expect(stillPending.state).toBe("pending");

    await ackCommandsThrough(runId, instanceId, 1, command.seq, new Date(), 2);
    const [acked] = await db
      .select({ state: workerChannelCommands.state })
      .from(workerChannelCommands)
      .where(eq(workerChannelCommands.id, command.id));
    expect(acked.state).toBe("acked");
  });
});

// ── 14.1 agent.event ──────────────────────────────────────────────────────────

describe("agent.event", () => {
  it("appends an agent_events row typed by the event's own type", async () => {
    const runId = await newRun();
    await apply(makeFrame(runId, "agent.event", { event: { type: "warning", text: "careful" } }));
    const rows = await db
      .select({ type: agentEvents.type, payload: agentEvents.payload })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "warning")));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ text: "careful" });
  });
});

// ── 14.1 worker.log ───────────────────────────────────────────────────────────

describe("worker.log", () => {
  it("coalesces batches into the bounded worker log tail across events", async () => {
    const runId = await newRun();
    await apply(makeFrame(runId, "worker.log", { entries: [{ message: "line one" }, { level: "err", message: "line two" }] }));
    await apply(makeFrame(runId, "worker.log", { entries: [{ message: "line three" }], droppedCount: 2 }));
    const rows = await db.select({ log: agentSessions.workerLog }).from(agentSessions).where(eq(agentSessions.id, runId));
    const log = rows[0].log ?? "";
    expect(log).toContain("line one");
    expect(log).toContain("[err] line two");
    expect(log).toContain("line three");
    expect(log).toContain("2 log entries dropped");
  });
});

// ── 14.2 run.phase (port: setStatus lease stamping) ───────────────────────────

describe("run.phase", () => {
  it("moves the run to running", async () => {
    const runId = await newRun();

    await apply(makeFrame(runId, "run.phase", { phase: "running" }));

    const row = (await db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.status).toBe("running");
    expect(await statusEvents(runId, "running")).toBe(1);
  });

  it("keeps the worker claim when the chat drive lands idle (worker waits for follow-ups)", async () => {
    // The worker emits `idle` immediately before exiting. Leaving worker_scope
    // behind keeps a claim on an exited worker, and sendMessageToRun then bridges
    // the next user message into a channel that is closed at idle (run 181).
    const runId = await newRun();
    await db.update(agentSessions).set({ deliveryVersion: 1 }).where(eq(agentSessions.id, runId));
    await db
      .update(agentSessions)
      .set({ workerScope: "to-run-1"})
      .where(eq(agentSessions.id, runId));

    await apply(makeFrame(runId, "run.phase", { phase: "idle" }));

    const row = (
      await db
        .select({ status: agentSessions.status, scope: agentSessions.workerScope })
        .from(agentSessions)
        .where(eq(agentSessions.id, runId))
    )[0];
    expect(row.status).toBe("idle");
    // The worker keeps waiting for follow-ups after landing idle: the claim
    // stays until resolveLiveness observes the process gone.
    expect(row.scope).toBe("to-run-1");
  });

  it("never regresses a run that already landed a terminal outcome", async () => {
    const runId = await newRun();
    await apply(makeFrame(runId, "run.cancelled", { requestId: "r", reason: "stop" }));
    expect(await runStatus(runId)).toBe("cancelled");

    await apply(makeFrame(runId, "run.phase", { phase: "running" }));

    expect(await runStatus(runId)).toBe("cancelled");
  });
});

// ── 14.2 run.checkpoint ───────────────────────────────────────────────────────

describe("run.checkpoint", () => {
  it("assigns a pending follow-up to the next durable input command", async () => {
    const runId = await newRun();
    const [msg] = await db.insert(agentMessages).values({ runId, role: "user", content: "[]" }).returning({ id: agentMessages.id });
    const firstInput = randomUUID(); const turnId = randomUUID();
    await db.insert(runInputs).values({ id: firstInput, runId, inputSeq: 1, messageId: msg.id, kind: "user", status: "assigned", assignedTurnId: turnId });
    await db.insert(runTurns).values({ id: turnId, runId, ordinal: 1, state: "active", inputManifest: [{ id: firstInput }], executionGeneration: 1 });
    const [followup] = await db.insert(agentMessages).values({ runId, role: "user", content: JSON.stringify([{ type: "text", text: "next" }]) }).returning({ id: agentMessages.id });
    const followupInput = randomUUID();
    await db.insert(runInputs).values({ id: followupInput, runId, inputSeq: 2, messageId: followup.id, kind: "user", status: "pending" });
    const result = await apply(makeFrame(runId, "run.checkpoint", { sdkSessionId: "sdk", turnId, inputIds: [firstInput] }, { workerGeneration: 1 }));
    const command = (await db.select({ type: workerChannelCommands.type, payload: workerChannelCommands.payload }).from(workerChannelCommands).where(eq(workerChannelCommands.id, result.resultCommandId!)))[0];
    expect(command.type).toBe("run.input");
    expect((command.payload as any).inputIds).toEqual([followupInput]);
    expect((await db.select({ status: runInputs.status }).from(runInputs).where(eq(runInputs.id, followupInput)))) .toMatchObject([{ status: "assigned" }]);
  });
  it("lands budget exhaustion before claiming a queued follow-up", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running", budgetMaxTurns: 1 }).where(eq(agentSessions.id, runId));
    const [msg] = await db.insert(agentMessages).values({ runId, role: "user", content: "[]" }).returning({ id: agentMessages.id });
    const firstInput = randomUUID(); const turnId = randomUUID();
    await db.insert(runInputs).values({ id: firstInput, runId, inputSeq: 1, messageId: msg.id, kind: "user", status: "assigned", assignedTurnId: turnId });
    await db.insert(runTurns).values({ id: turnId, runId, ordinal: 1, state: "active", inputManifest: [{ id: firstInput }], executionGeneration: 1 });
    const [followup] = await db.insert(agentMessages).values({ runId, role: "user", content: "[]" }).returning({ id: agentMessages.id });
    await db.insert(runInputs).values({ id: randomUUID(), runId, inputSeq: 2, messageId: followup.id, kind: "user", status: "pending" });
    const result = await apply(makeFrame(runId, "run.checkpoint", { sdkSessionId: "sdk", turnId, inputIds: [firstInput] }, { workerGeneration: 1 }));
    expect(result.resultCommandId).toBeTruthy();
    expect((await db.select({ type: workerChannelCommands.type, payload: workerChannelCommands.payload }).from(workerChannelCommands).where(eq(workerChannelCommands.id, result.resultCommandId!)))[0].type).toBe("run.commit");
    expect(await db.select({ status: runInputs.status }).from(runInputs).where(eq(runInputs.messageId, followup.id))).toMatchObject([{ status: "pending" }]);
  });
  it("returns an explicit finalize decision after a v2 durable receipt", async () => {
    const runId = await newRun();
    const [msg] = await db.insert(agentMessages).values({ runId, role: "user", content: "[]" }).returning({ id: agentMessages.id });
    const inputId = randomUUID(); const turnId = randomUUID();
    await db.insert(runInputs).values({ id: inputId, runId, inputSeq: 1, messageId: msg.id, kind: "user", status: "assigned", assignedTurnId: turnId });
    await db.insert(runTurns).values({ id: turnId, runId, ordinal: 1, state: "active", inputManifest: [{ id: inputId }], executionGeneration: 1 });
    const result = await apply(makeFrame(runId, "run.checkpoint", { sdkSessionId: "sdk", turnId, inputIds: [inputId] }, { workerGeneration: 1 }));
    expect(result.resultCommandId).toBeTruthy();
    const command = (await db.select({ type: workerChannelCommands.type, payload: workerChannelCommands.payload }).from(workerChannelCommands).where(eq(workerChannelCommands.id, result.resultCommandId!)))[0];
    expect(command.type).toBe("run.park"); expect((command.payload as any).action).toBe("finalize");
  });
  it("updates sdkSessionId and allowlisted metadata only", async () => {
    const runId = await newRun();
    await apply(
      makeFrame(runId, "run.checkpoint", {
        sdkSessionId: "sess-9",
        metadata: { branch: "feat/x", prUrl: "https://example.com/pr/1", status: "hacked", inputTokens: 5 },
      })
    );
    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.sdkSessionId).toBe("sess-9");
    expect(row.branch).toBe("feat/x");
    expect(row.prUrl).toBe("https://example.com/pr/1");
    expect(row.inputTokens).toBe(5);
    // The non-allowlisted `status` key in metadata must NOT move the column.
    expect(row.status).not.toBe("hacked");
  });

  it("writes a turn_done marker so the message relay closes the turn", async () => {
    // A chat run lands resumable-'idle' rather than a terminal status, so
    // relayRunStream (POST /api/runs/[id]/messages) closes the stream only on a
    // per-turn turn_done event. Each completed chat turn emits exactly one
    // run.checkpoint; that must leave behind exactly one turn_done or the composer
    // hangs after the first message, unable to send a follow-up.
    const runId = await newRun();
    await apply(makeFrame(runId, "run.checkpoint", { sdkSessionId: "sess-1" }));
    const marks = await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "turn_done")));
    expect(marks).toHaveLength(1);
  });
});

// ── 14.3 run.finished (port: atomic-finalize idempotency + timers) ────────────

describe("run.finished", () => {
  it.each([
    ["report_result", { kind: "result", status: "failed", summary: "reported failure", data: null }],
    ["raise", { kind: "exception", code: "CHILD_FAILED", message: "raised failure", recoverable: false }],
  ])("preserves stored %s when the worker summary is only text", async (_kind, storedResult) => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running", result: storedResult }).where(eq(agentSessions.id, runId));

    await apply(makeFrame(runId, "run.finished", { result: "The turn completed." }));

    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.status).toBe("failed");
    expect(row.result).toEqual(storedResult);
    const commit = (await commits(runId))[0];
    expect(commit.payload).toMatchObject({ status: "failed", result: storedResult });
  });

  it("does not terminally finish when a queued input races completion", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));
    const [msg] = await db.insert(agentMessages).values({ runId, role: "user", content: "[]" }).returning({ id: agentMessages.id });
    await db.insert(runInputs).values({ id: randomUUID(), runId, inputSeq: 1, messageId: msg.id, kind: "user", status: "pending" });
    const result = await apply(makeFrame(runId, "run.finished", { result: { done: true } }));
    expect(await runStatus(runId)).not.toBe("completed");
    const command = (await db.select({ payload: workerChannelCommands.payload }).from(workerChannelCommands).where(eq(workerChannelCommands.id, result.resultCommandId!)))[0];
    expect(command.payload).toMatchObject({ accepted: false });
    expect(await db.select().from(runSourceEvents).where(eq(runSourceEvents.sourceRunId, runId))).toHaveLength(0);
  });
  it("lands completed atomically, cancels pending timers, and enqueues run.commit", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));
    await db.insert(runTimers).values({ runId, fireAt: new Date(Date.now() + 60_000), note: "await", status: "pending" });

    const result = await apply(makeFrame(runId, "run.finished", { result: { ok: true }, prUrl: "https://x/pr/2", usage: { inputTokens: 10, outputTokens: 20 } }));

    expect(await runStatus(runId)).toBe("completed");
    expect(await statusEvents(runId, "completed")).toBe(1);
    const timers = await db.select({ status: runTimers.status }).from(runTimers).where(eq(runTimers.runId, runId));
    expect(timers.map((t) => t.status)).toEqual(["cancelled"]);
    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.prUrl).toBe("https://x/pr/2");
    expect(row.inputTokens).toBe(10);
    const cmds = await commits(runId);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].payload).toMatchObject({ status: "completed", accepted: true, finishEventId: expect.any(String) });
    expect(result.resultCommandId).toBe(cmds[0].id);
  });

  it("is idempotent on a redelivered finish: one event, one commit", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));
    const frame = makeFrame(runId, "run.finished", { result: { ok: true } }, { id: randomUUID(), seq: 1 });

    const first = await apply(frame);
    const second = await apply(frame);

    expect(second.duplicate).toBe(true);
    expect(second.resultCommandId).toBe(first.resultCommandId);
    expect(await statusEvents(runId, "completed")).toBe(1);
    expect(await commits(runId)).toHaveLength(1);
  });
});

// ── 14.3 run.failed (port: setError does not overwrite a completed run) ───────

describe("run.failed", () => {
  it("lands failure with a normalized error and enqueues run.commit", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));

    await apply(makeFrame(runId, "run.failed", { error: "  boom  " }));

    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.status).toBe("failed");
    expect(row.error).toBe("boom");
    const cmds = await commits(runId);
    expect(cmds[0].payload).toMatchObject({ status: "failed", accepted: true });
  });

  it("does not overwrite an already-completed run: run.commit reports the authoritative outcome with accepted:false", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));
    await apply(makeFrame(runId, "run.finished", { result: { ok: true } })); // seq 1
    await apply(makeFrame(runId, "run.failed", { error: "late failure" })); // seq 2 — conflicts

    expect(await runStatus(runId)).toBe("completed"); // terminal landing untouched
    expect(await statusEvents(runId, "failed")).toBe(0);
    const cmds = await commits(runId);
    const conflict = cmds.find((c) => c.payload.accepted === false);
    expect(conflict).toBeTruthy();
    expect(conflict!.payload.status).toBe("completed");
  });
});

// ── 14.3 run.cancelled (port: claim release + cross-process cancel) ───────────

describe("run.cancelled", () => {
  it("lands cancelled, clears the worker claim, and enqueues run.commit", async () => {
    const runId = await newRun();
    await db
      .update(agentSessions)
      .set({ status: "running", workerScope: "scope-1"})
      .where(eq(agentSessions.id, runId));

    await apply(makeFrame(runId, "run.cancelled", { requestId: "req-1", reason: "user stop" }));

    const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
    expect(row.status).toBe("cancelled");
    expect(row.workerScope).toBeNull();
    expect(await statusEvents(runId, "cancelled")).toBe(1);
    const cmds = await commits(runId);
    expect(cmds[0].payload).toMatchObject({ status: "cancelled", accepted: true });
  });
});

// ── BUG 2: live SSE emissions must observe committed state ────────────────────

describe("live emission ordering", () => {
  it("fires the live status event only after the terminal transaction commits", async () => {
    const runId = await newRun();
    await db.update(agentSessions).set({ status: "running" }).where(eq(agentSessions.id, runId));

    // Register a live run bus (the SSE subscription surface) so emitRunEvent is not
    // a no-op, then subscribe as an SSE client that re-fetches the run row when the
    // pushed "status" event arrives.
    const runsMod = await import("../lib/runs");
    const bus = new EventEmitter();
    const runners = (globalThis as unknown as { __runRunners: Map<number, { abort: AbortController; bus: EventEmitter }> })
      .__runRunners;
    runners.set(runId, { abort: new AbortController(), bus });

    let observedStatus: string | null = null;
    const unsub = runsMod.subscribe(runId, (event) => {
      if ((event as { type?: string }).type !== "status") return;
      // A separate query: on the old code (emit inside the open transaction) this
      // reads the last committed value "running"; with the fix it reads "completed"
      // because the emission is flushed only after COMMIT.
      void db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, runId))
        .then((rows) => {
          observedStatus = rows[0]!.status;
        });
    });

    try {
      await apply(makeFrame(runId, "run.finished", { result: { ok: true } }));
      await waitForCond(() => observedStatus !== null);
      expect(observedStatus).toBe("completed");
    } finally {
      unsub();
      runners.delete(runId);
    }
  });
});

// ── persistCommandTx: no self-deadlock inside applyWorkerEvent's transaction ──

describe("persistCommandTx deadlock-freedom", () => {
  it("enqueues a command from inside the event transaction without deadlocking", async () => {
    const runId = await newRun();
    // A handler that enqueues a command via the tx-scoped variant. persistCommand
    // (its own-transaction sibling) would block forever here waiting on the
    // channel + runner locks this very transaction already holds; persistCommandTx
    // reuses the open tx, so effect + command + receipt commit as one unit.
    const frame = makeFrame(runId, "run.phase", { phase: "running" }, { seq: 1 });
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("persistCommandTx deadlocked")), 5_000);
      t.unref?.();
    });
    const applied = applyWorkerEvent(frame, async (tx, f) => {
      const row = await persistCommandTx(tx, {
        runId: f.runId,
        instanceId: f.instanceId,
        controllerEpoch: f.controllerEpoch,
        type: "run.park",
        payload: { reason: "from-handler" },
      });
      return { resultCommandId: row.id };
    });

    const result = await Promise.race([applied, timeout]);
    expect(result.duplicate).toBe(false);
    const parks = await db
      .select({ state: workerChannelCommands.state })
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "run.park")));
    expect(parks).toHaveLength(1);
    // The receipt for the event committed in the same transaction as the command.
    expect(result.resultCommandId).toBeTruthy();
  });
});
