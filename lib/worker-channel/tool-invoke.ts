// lib/worker-channel/tool-invoke.ts
//
// Control-plane handling of the `tool.invoke` worker event (plan section 15).
//
// An agent tool call arrives as a `tool.invoke` event on the same channel. The
// control plane — never the worker — executes it through the server tool
// registry and replies with a `tool.result` command. The eight rules from the
// plan map onto this module as follows:
//
//   1. derive run/task/plan/author scope from the channel — deriveToolContext
//      keys everything off the channel's runId; the worker payload cannot
//      override the scope (there is no author/task field in ToolInvoke).
//   2. reject tools absent from the persisted start policy — getRunStartPolicy.
//   3. store the receipt before exposing any result — reserveToolInvoke records
//      the receipt (via applyWorkerEvent) and acks the worker sequence BEFORE
//      the tool runs; the result is only exposed later as a tool.result command.
//   4. execute through lib/worker/server-tools.ts — resolveServerTool.
//   5. send tool.accepted before work that may exceed 5 seconds — the slow timer
//      in executeToolInvoke.
//   6. persist one tool.result command linked from the receipt —
//      persistToolResultCommand.
//   7. replay that exact command on duplicate invocation — reserveToolInvoke
//      returns the linked command for a duplicate envelope id.
//   8. never rerun an invocation whose side effect committed — a duplicate
//      envelope id short-circuits in the receipt layer, so the server tool is
//      never executed twice.
//
// The two entry points are deliberately split so the connection manager can run
// the receipt reservation + ack INSIDE its serial receive loop (preserving
// worker-sequence contiguity) and then FLOAT the possibly-long execution.

import { dbTransport } from "../worker/db-transport";
import {
  applyWorkerEvent,
  getCommand,
  getRunStartPolicy,
  listOrphanedToolInvokes,
  persistCommand,
  persistToolResultCommand,
  type CommandRow,
} from "./repository";
import { handleWorkerEvent } from "./event-handler";
import type {
  ToolInvoke,
  ToolInvokeEnvelope,
  ToolResult,
  WireFrame,
  WorkerCommand,
} from "./protocol";

/** How long a tool may run before the worker is told it is executing async
 *  (plan section 15 rule 5). */
export const TOOL_ACCEPTED_THRESHOLD_MS = 5_000;

/** Minimal transport seam the tool handler needs from a controller connection. */
export interface ToolChannelIO {
  readonly epoch: number;
  readonly connected: boolean;
  send(frame: WireFrame): void;
}

function structuredError(callId: string, text: string): ToolResult {
  return { callId, result: { content: [{ type: "text", text }], isError: true }, isError: true };
}

/** Convert a persisted command row into an on-wire command frame. */
function commandFrame(row: CommandRow, replyTo?: string): WorkerCommand {
  return {
    v: 1,
    type: row.type as WorkerCommand["type"],
    id: row.id,
    runId: row.runId,
    instanceId: row.instanceId,
    controllerEpoch: row.controllerEpoch,
    seq: row.seq,
    sentAt: row.createdAt.toISOString(),
    payload: row.payload as never,
    ...(replyTo ? { replyTo } : {}),
  } as WorkerCommand;
}

function channelAckFrame(io: ToolChannelIO, frame: ToolInvokeEnvelope, throughSeq: number): WireFrame {
  return {
    v: 1,
    type: "channel.ack",
    id: crypto.randomUUID(),
    runId: frame.runId,
    instanceId: frame.instanceId,
    controllerEpoch: io.epoch,
    seq: 0,
    sentAt: new Date().toISOString(),
    payload: { throughSeq },
  } as WireFrame;
}

/**
 * Author/task/plan scope for a tool call, derived entirely from the run the
 * channel is bound to (rule 1). The worker cannot influence any of these.
 */
export async function deriveToolContext(
  runId: number
): Promise<{ author: string; defaultTaskId?: string; defaultPlanId?: string }> {
  const run = await dbTransport.getRun(runId);
  const author = run?.goal === "<chat>" ? "chat" : "claude-agent";
  return {
    author,
    defaultTaskId: run?.taskId ?? undefined,
    defaultPlanId: run?.planId ?? undefined,
  };
}

export interface ExecuteChannelToolOptions {
  /** Invoked once if the tool is still running after `slowThresholdMs`. */
  onSlow?: () => void;
  slowThresholdMs?: number;
}

/**
 * Validate and execute one tool against the server registry, returning the
 * `tool.result` payload. Enforces the start policy (rule 2), derives scope from
 * the channel (rule 1), executes through the server tools (rule 4), and arms the
 * slow-tool notification (rule 5). Never throws for a tool-level failure — a
 * structured error result is returned so the agent sees it as a normal result.
 */
export async function executeChannelTool(
  runId: number,
  instanceId: string,
  payload: ToolInvoke,
  opts: ExecuteChannelToolOptions = {}
): Promise<ToolResult> {
  const { callId, tool } = payload;

  const policy = await getRunStartPolicy(runId, instanceId);
  if (!policy || !policy.allowedTools.includes(tool)) {
    return structuredError(
      callId,
      `Tool '${tool}' is not permitted for this run (not in the authorized start policy).`
    );
  }

  const { resolveServerTool } = await import("../worker/server-tools");
  const def = await resolveServerTool(tool);
  if (!def) return structuredError(callId, `Unknown tool: ${tool}`);

  const ctx = await deriveToolContext(runId);

  let slowTimer: ReturnType<typeof setTimeout> | undefined;
  if (opts.onSlow) {
    slowTimer = setTimeout(opts.onSlow, opts.slowThresholdMs ?? TOOL_ACCEPTED_THRESHOLD_MS);
    slowTimer.unref?.();
  }
  try {
    const result = await def.execute(payload.arguments, { ...ctx, runId });
    return { callId, result, isError: result.isError ?? false };
  } catch (err) {
    return structuredError(callId, err instanceof Error ? err.message : String(err));
  } finally {
    if (slowTimer) clearTimeout(slowTimer);
  }
}

export interface ReserveOutcome {
  duplicate: boolean;
  /** Highest contiguous worker sequence accepted (the ack cursor). */
  throughSeq: number;
  /** For a duplicate whose result was already produced: the exact command to
   *  replay (rule 7). Undefined for a fresh invocation or an in-flight one. */
  replay?: CommandRow;
  /** A duplicate whose receipt committed but whose tool.result was NEVER produced
   *  (`result_command_id` is null). The invocation was received and acked, then its
   *  result was lost to a crash or a throw — the caller must RE-EXECUTE it or the
   *  agent's tool call hangs forever (BUG 1a). Distinct from a duplicate-with-result
   *  (replay only) and from a fresh invocation (execute for the first time). */
  reexecute?: boolean;
}

/**
 * Envelope ids whose {@link executeToolInvoke} is currently running in THIS
 * process. The redelivery re-exec path (BUG 1a) and the reconnect sweep (BUG 1b)
 * both may target an invocation whose first execution is still producing its
 * result here; this Set lets them skip it so the tool's side effect is not run a
 * second time in-process. `persistToolResultCommand` additionally dedupes across
 * processes by `invokeEventId`, so a cross-process race is safe too — this only
 * trims the common same-process double-run.
 */
const inFlightInvocations = new Set<string>();

/**
 * Record the invocation receipt and acknowledge its worker sequence (rule 3).
 * This MUST run inside the connection's serial receive loop so the worker
 * sequence cursor advances in order. Returns whether the invocation is a
 * duplicate (already received) and, if its result was already produced, the
 * command to replay.
 */
export async function reserveToolInvoke(
  frame: ToolInvokeEnvelope,
  io: ToolChannelIO
): Promise<ReserveOutcome> {
  const applied = await applyWorkerEvent(frame, handleWorkerEvent);
  io.send(channelAckFrame(io, frame, applied.lastAcceptedWorkerSeq));
  if (applied.duplicate) {
    let replay: CommandRow | undefined;
    if (applied.resultCommandId) {
      const command = await getCommand(applied.resultCommandId);
      if (command && command.controllerEpoch === io.epoch) replay = command;
    }
    // No linked result command means the result was never produced: re-execute
    // (BUG 1a). When a result exists under an older epoch (replay left undefined by
    // the epoch check above), do NOT re-execute — the persisted result is delivered
    // by the pending-command replay after rebasePendingCommands.
    return {
      duplicate: true,
      throughSeq: applied.lastAcceptedWorkerSeq,
      replay,
      reexecute: !applied.resultCommandId,
    };
  }
  return { duplicate: false, throughSeq: applied.lastAcceptedWorkerSeq };
}

/**
 * Execute a freshly-received tool invocation and deliver its result (rules 4-6).
 * Safe to FLOAT off the serial receive loop: the long-running tool must not
 * block subsequent channel frames. If the controller has since disconnected, the
 * persisted `tool.result` command is delivered on reconnect by the pending-
 * command replay (matched to the worker's waiter by callId).
 */
export async function executeToolInvoke(frame: ToolInvokeEnvelope, io: ToolChannelIO): Promise<void> {
  // In-process re-entrancy guard: a live redelivery (BUG 1a) or the reconnect
  // sweep (BUG 1b) may target an invocation whose first execution is still in
  // flight here. Skip it — the running execution persists the one tool.result.
  if (inFlightInvocations.has(frame.id)) return;
  inFlightInvocations.add(frame.id);
  try {
    await executeToolInvokeInner(frame, io);
  } finally {
    inFlightInvocations.delete(frame.id);
  }
}

async function executeToolInvokeInner(frame: ToolInvokeEnvelope, io: ToolChannelIO): Promise<void> {
  const payload = frame.payload as ToolInvoke;

  const result = await executeChannelTool(frame.runId, frame.instanceId, payload, {
    onSlow: () => {
      // Fire-and-forget: the accepted notice is advisory. A failure to deliver it
      // never affects the eventual tool.result.
      void (async () => {
        try {
          const command = await persistCommand({
            runId: frame.runId,
            instanceId: frame.instanceId,
            controllerEpoch: io.epoch,
            type: "tool.accepted",
            payload: { callId: payload.callId },
          });
          if (command.controllerEpoch === io.epoch && io.connected) io.send(commandFrame(command));
        } catch {
          /* advisory only */
        }
      })();
    },
  });

  const command = await persistToolResultCommand({
    runId: frame.runId,
    instanceId: frame.instanceId,
    controllerEpoch: io.epoch,
    invokeEventId: frame.id,
    payload: result,
  });
  if (command.controllerEpoch === io.epoch && io.connected) io.send(commandFrame(command, frame.id));
}

/**
 * Recover tool invocations stranded by a control-plane crash (BUG 1b). If the
 * process dies (or `persistToolResultCommand`/`executeChannelTool` throws) after
 * the receipt commits and its worker sequence is acked but before a `tool.result`
 * is produced, nothing retries it: the worker never replays an already-acked
 * invocation, and on redelivery the receipt short-circuits as a duplicate. Such an
 * invocation would leave the agent's tool call hung forever.
 *
 * Run this once on a FRESH connect, after pending commands are replayed. It finds
 * each orphaned receipt (result_command_id null) with a durable invoke payload,
 * reconstructs the envelope, and re-executes it. Safe to run concurrently with a
 * live redelivery: {@link executeToolInvoke}'s in-flight Set skips an id already
 * running here, and `persistToolResultCommand` dedupes across processes — so a
 * result is persisted exactly once and the tool never double-runs in-process. It
 * is fire-and-forget (never blocks the receive loop) and idempotent: a second pass
 * finds nothing, because the first linked each receipt to its result command.
 */
export async function sweepOrphanedToolInvokes(
  runId: number,
  instanceId: string,
  io: ToolChannelIO
): Promise<void> {
  const orphans = await listOrphanedToolInvokes(runId, instanceId);
  for (const orphan of orphans) {
    const frame: ToolInvokeEnvelope = {
      v: 1,
      type: "tool.invoke",
      id: orphan.id,
      runId: orphan.runId,
      instanceId: orphan.instanceId,
      // The result command is persisted under io.epoch (the current controller
      // epoch), not the epoch the invocation was first emitted under. sentAt is
      // diagnostic only.
      controllerEpoch: io.epoch,
      seq: orphan.seq,
      sentAt: new Date().toISOString(),
      payload: orphan.payload as ToolInvoke,
    } as ToolInvokeEnvelope;
    await executeToolInvoke(frame, io).catch(() => undefined);
  }
}
