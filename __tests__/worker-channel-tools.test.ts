// __tests__/worker-channel-tools.test.ts
//
// Control-plane `tool.invoke` handling (plan section 15). Exercises the eight
// rules against a real database and the channel repository, with the server
// tool registry mocked so side effects, slow tools, image results, and failures
// are deterministic:
//
//   • allowed vs denied tools (start-policy gate, rule 2);
//   • scope is derived from the channel, not the payload (rule 1);
//   • the receipt is stored before the result is exposed, and a duplicate
//     invocation replays the exact command WITHOUT re-running the tool
//     (rules 3, 7, 8 — the duplicate side-effect guard);
//   • the long-running accepted → result flow (rule 5);
//   • a disconnect between commit and delivery still delivers on reconnect;
//   • structured errors and image results survive the round trip;
//   • spawn/memory/PR-lock-style tools route through the same path.

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances, workerChannelCommands, workerChannelReceipts } from "../db/schema";
import { create } from "../lib/runs";
import { persistCommand, type CommandRow } from "../lib/worker-channel/repository";
import {
  executeChannelTool,
  executeToolInvoke,
  reserveToolInvoke,
  sweepOrphanedToolInvokes,
  type ToolChannelIO,
} from "../lib/worker-channel/tool-invoke";
import type { OrchestratorTool } from "../lib/orchestrator-tools";
import type { ToolInvokeEnvelope, WireFrame } from "../lib/worker-channel/protocol";

// ── mocked server tool registry ──────────────────────────────────────────────
const registry = new Map<string, OrchestratorTool>();
vi.mock("../lib/worker/server-tools", () => ({
  resolveServerTool: async (name: string) => registry.get(name) ?? null,
}));

const instanceId = "wi_0123456789abcdef0123456789abcdef";
const EPOCH = 1;

let ctxSeen: unknown = null;
let counter = 0;

function tool(name: string, execute: OrchestratorTool["execute"]): OrchestratorTool {
  return { name, label: name, description: name, parameters: {} as never, execute };
}

function seedRegistry(): void {
  registry.clear();
  ctxSeen = null;
  counter = 0;
  registry.set(
    "echo",
    tool("echo", async (params, ctx) => {
      ctxSeen = ctx;
      return { content: [{ type: "text", text: `echo:${JSON.stringify(params)}` }] };
    })
  );
  registry.set(
    "counter",
    tool("counter", async () => {
      counter += 1;
      return { content: [{ type: "text", text: `count=${counter}` }] };
    })
  );
  registry.set(
    "boom",
    tool("boom", async () => {
      throw new Error("kaboom");
    })
  );
  registry.set(
    "structured_error",
    tool("structured_error", async () => ({
      content: [{ type: "text", text: "invalid task id" }],
      isError: true,
    }))
  );
  registry.set(
    "image_tool",
    tool("image_tool", async () => ({
      content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    }))
  );
  registry.set(
    "spawn__start_session",
    tool("spawn__start_session", async () => ({ content: [{ type: "text", text: "child spawned" }] }))
  );
  registry.set(
    "memory_remember",
    tool("memory_remember", async () => ({ content: [{ type: "text", text: "stored" }] }))
  );
  registry.set(
    "pr_merge",
    tool("pr_merge", async () => {
      counter += 1;
      return { content: [{ type: "text", text: `merged#${counter}` }] };
    })
  );
}

const ALLOWED = [
  "echo",
  "counter",
  "boom",
  "structured_error",
  "image_tool",
  "spawn__start_session",
  "memory_remember",
  "pr_merge",
  "slow",
];

async function newRun(goal = "<implement>"): Promise<number> {
  const run = await create({ goal, defer: true });
  await db.insert(runnerInstances).values({
    runId: run.id,
    channelInstanceId: instanceId,
    channelEndpoint: "ws://127.0.0.1:8787/worker/channel",
  });
  // Persist the authoritative run.start command carrying the start policy the
  // control plane gates tool.invoke on (rule 2).
  await persistCommand({
    runId: run.id,
    instanceId,
    controllerEpoch: EPOCH,
    type: "run.start",
    payload: { mode: "start", policy: { allowedTools: ALLOWED, maxTurns: null, deadline: null } },
  });
  return run.id;
}

const seqByRun = new Map<number, number>();
function nextSeq(runId: number): number {
  const seq = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, seq);
  return seq;
}

function invokeFrame(
  runId: number,
  tool: string,
  args: unknown,
  opts: { id?: string; seq?: number; callId?: string } = {}
): ToolInvokeEnvelope {
  return {
    v: 1,
    type: "tool.invoke",
    id: opts.id ?? randomUUID(),
    runId,
    instanceId,
    controllerEpoch: EPOCH,
    seq: opts.seq ?? nextSeq(runId),
    sentAt: new Date().toISOString(),
    payload: { callId: opts.callId ?? `call-${randomUUID()}`, tool, arguments: args },
  } as ToolInvokeEnvelope;
}

interface CapturingIO extends ToolChannelIO {
  sent: WireFrame[];
}
function makeIO(connected = true): CapturingIO {
  const sent: WireFrame[] = [];
  return { epoch: EPOCH, connected, send: (frame) => sent.push(frame), sent };
}

/** The tool.result payload carried by a delivered command frame. */
function resultOf(frame: WireFrame): { callId: string; result: any; isError?: boolean } {
  return (frame as { payload: any }).payload;
}
function toolResultFrames(io: CapturingIO): WireFrame[] {
  return io.sent.filter((f) => (f as { type?: string }).type === "tool.result");
}

beforeEach(() => {
  seedRegistry();
  seqByRun.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(agentSessions);
});

describe("control-plane tool.invoke handling (plan section 15)", () => {
  it("executes an allowed tool and delivers its result over the channel", async () => {
    const runId = await newRun();
    const io = makeIO();
    const frame = invokeFrame(runId, "echo", { a: 1 });

    const reserved = await reserveToolInvoke(frame, io);
    expect(reserved.duplicate).toBe(false);
    await executeToolInvoke(frame, io);

    const results = toolResultFrames(io);
    expect(results).toHaveLength(1);
    expect(resultOf(results[0]).result.isError ?? false).toBe(false);
    expect(resultOf(results[0]).result.content[0].text).toContain("echo");
    // The delivered command replies to the invocation envelope id.
    expect((results[0] as { replyTo?: string }).replyTo).toBe(frame.id);
  });

  it("rejects a tool absent from the persisted start policy (rule 2)", async () => {
    const runId = await newRun();
    const io = makeIO();
    const frame = invokeFrame(runId, "not_allowed", {});

    await reserveToolInvoke(frame, io);
    await executeToolInvoke(frame, io);

    const result = resultOf(toolResultFrames(io)[0]).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not permitted");
    // The forbidden tool never reached the registry.
    expect(counter).toBe(0);
  });

  it("derives author/scope from the channel, not the payload (rule 1)", async () => {
    const runId = await newRun("<chat>");
    // A spoofed scope smuggled through the tool arguments must be ignored: the
    // context the tool runs with comes from the run, not the payload.
    const result = await executeChannelTool(runId, instanceId, {
      callId: "c1",
      tool: "echo",
      arguments: { author: "attacker", taskId: "T-evil", defaultPlanId: "P-evil" },
    });
    expect(result.isError).toBe(false);
    expect((ctxSeen as { author: string }).author).toBe("chat");
    expect((ctxSeen as { runId: number }).runId).toBe(runId);
    expect((ctxSeen as { defaultPlanId?: string }).defaultPlanId).toBeUndefined();
  });

  it("stores the receipt and replays the exact command on a duplicate without re-running (rules 3,7,8)", async () => {
    const runId = await newRun();
    const io = makeIO();
    const frame = invokeFrame(runId, "counter", {});

    await reserveToolInvoke(frame, io);
    await executeToolInvoke(frame, io);
    expect(counter).toBe(1);
    const firstResult = resultOf(toolResultFrames(io)[0]).result.content[0].text;

    // A redelivered invocation (same envelope id AND sequence) is a duplicate:
    // the receipt short-circuits, the tool is NOT run again, and the exact prior
    // command is replayed.
    const io2 = makeIO();
    const dupFrame = invokeFrame(runId, "counter", {}, { id: frame.id, seq: frame.seq, callId: frame.payload.callId });
    const reserved = await reserveToolInvoke(dupFrame, io2);
    expect(reserved.duplicate).toBe(true);
    expect(reserved.replay).toBeDefined();
    expect(counter).toBe(1); // never re-ran the side effect
    expect((reserved.replay as CommandRow).payload).toMatchObject({});
    const replayText = (reserved.replay as CommandRow).payload as { result: any };
    expect(replayText.result.content[0].text).toBe(firstResult);

    // Exactly one tool.result command persisted for the invocation.
    const commands = await db
      .select()
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "tool.result")));
    expect(commands).toHaveLength(1);
    const receipt = await db
      .select()
      .from(workerChannelReceipts)
      .where(eq(workerChannelReceipts.id, frame.id));
    expect(receipt[0]?.resultCommandId).toBe(commands[0].id);
  });

  it("surfaces a thrown tool as a structured error result", async () => {
    const runId = await newRun();
    const io = makeIO();
    const frame = invokeFrame(runId, "boom", {});
    await reserveToolInvoke(frame, io);
    await executeToolInvoke(frame, io);
    const result = resultOf(toolResultFrames(io)[0]).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });

  it("preserves a tool's own structured error result", async () => {
    const runId = await newRun();
    const result = await executeChannelTool(runId, instanceId, {
      callId: "c",
      tool: "structured_error",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.result as any).isError).toBe(true);
  });

  it("round-trips an image result", async () => {
    const runId = await newRun();
    const io = makeIO();
    const frame = invokeFrame(runId, "image_tool", {});
    await reserveToolInvoke(frame, io);
    await executeToolInvoke(frame, io);
    const block = resultOf(toolResultFrames(io)[0]).result.content[0];
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/png");
  });

  it("sends tool.accepted before a slow tool's result (rule 5)", async () => {
    const runId = await newRun();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registry.set(
      "slow",
      tool("slow", async () => {
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      })
    );
    const onSlow = vi.fn();
    const promise = executeChannelTool(
      runId,
      instanceId,
      { callId: "c", tool: "slow", arguments: {} },
      { onSlow, slowThresholdMs: 10 }
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(onSlow).toHaveBeenCalledTimes(1);
    release();
    const result = await promise;
    expect((result.result as any).content[0].text).toBe("done");
  });

  it("delivers a persisted result on reconnect after a disconnect between commit and delivery", async () => {
    const runId = await newRun();
    // Controller disconnected while the tool ran: the result command is persisted
    // but not sent.
    const offline = makeIO(false);
    const frame = invokeFrame(runId, "counter", {});
    await reserveToolInvoke(frame, offline);
    await executeToolInvoke(frame, offline);
    expect(toolResultFrames(offline)).toHaveLength(0);
    const commands = await db
      .select()
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "tool.result")));
    expect(commands).toHaveLength(1);

    // On reconnect the worker replays the invocation; the receipt returns the
    // exact command for redelivery, and the side effect never re-runs.
    const online = makeIO(true);
    const dup = invokeFrame(runId, "counter", {}, { id: frame.id, seq: frame.seq, callId: frame.payload.callId });
    const reserved = await reserveToolInvoke(dup, online);
    expect(reserved.duplicate).toBe(true);
    expect((reserved.replay as CommandRow).id).toBe(commands[0].id);
    expect(counter).toBe(1);
  });

  it("re-executes a redelivered invocation whose receipt has no result command (BUG 1a)", async () => {
    const runId = await newRun();
    // First delivery: the receipt is reserved and its worker seq acked, but the
    // result is NEVER produced — simulating a crash/throw between the receipt
    // commit and persistToolResultCommand. Nothing runs the tool yet.
    const io = makeIO();
    const frame = invokeFrame(runId, "counter", {});
    const first = await reserveToolInvoke(frame, io);
    expect(first.duplicate).toBe(false);
    expect(counter).toBe(0);

    // The worker redelivers the same envelope (its outbox never saw the ack). The
    // receipt short-circuits as a duplicate, but with NO linked result command, so
    // the caller must re-execute rather than drop it (which would hang the agent).
    const io2 = makeIO();
    const dup = invokeFrame(runId, "counter", {}, { id: frame.id, seq: frame.seq, callId: frame.payload.callId });
    const reserved = await reserveToolInvoke(dup, io2);
    expect(reserved.duplicate).toBe(true);
    expect(reserved.replay).toBeUndefined();
    expect(reserved.reexecute).toBe(true);

    await executeToolInvoke(dup, io2);
    expect(counter).toBe(1);
    const results = toolResultFrames(io2);
    expect(results).toHaveLength(1);
    expect(resultOf(results[0]).result.content[0].text).toBe("count=1");
    expect((results[0] as { replyTo?: string }).replyTo).toBe(frame.id);
    const commands = await db
      .select()
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "tool.result")));
    expect(commands).toHaveLength(1);
  });

  it("sweeps an orphaned tool.invoke receipt on reconnect and re-executes it (BUG 1b)", async () => {
    const runId = await newRun();
    // A stranded invocation: receipt committed + acked, result never produced, and
    // the worker will not replay it (it was acked). The durable invoke payload on
    // the receipt is the only surviving copy of the arguments.
    const io = makeIO();
    const frame = invokeFrame(runId, "counter", {});
    await reserveToolInvoke(frame, io);
    expect(counter).toBe(0);

    // The reconnect sweep finds the orphan and re-executes it, delivering the
    // result over the fresh connection.
    const io2 = makeIO();
    await sweepOrphanedToolInvokes(runId, instanceId, io2);
    expect(counter).toBe(1);
    const results = toolResultFrames(io2);
    expect(results).toHaveLength(1);
    expect((results[0] as { replyTo?: string }).replyTo).toBe(frame.id);
    const commands = await db
      .select()
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "tool.result")));
    expect(commands).toHaveLength(1);

    // Idempotent: the receipt is now linked to its result command, so a second
    // sweep finds no orphan and re-runs nothing.
    const io3 = makeIO();
    await sweepOrphanedToolInvokes(runId, instanceId, io3);
    expect(counter).toBe(1);
    expect(toolResultFrames(io3)).toHaveLength(0);
  });

  it("does not double-execute an invocation already in flight in this process", async () => {
    const runId = await newRun();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    registry.set(
      "slow",
      tool("slow", async () => {
        runs += 1;
        await gate;
        return { content: [{ type: "text", text: "done" }] };
      })
    );
    const io = makeIO();
    const frame = invokeFrame(runId, "slow", {});
    await reserveToolInvoke(frame, io);

    // First execution starts and blocks on the gate. A redelivery arrives while it
    // is still in flight: the in-flight guard makes the second call a no-op, so the
    // tool body runs exactly once.
    const p1 = executeToolInvoke(frame, io);
    await new Promise((r) => setTimeout(r, 20));
    const io2 = makeIO();
    await executeToolInvoke(frame, io2);
    expect(runs).toBe(1);
    expect(toolResultFrames(io2)).toHaveLength(0);

    release();
    await p1;
    expect(runs).toBe(1);
    expect(toolResultFrames(io)).toHaveLength(1);
  });

  it("routes spawn, memory, and PR-mutating tools through the same path", async () => {
    const runId = await newRun();
    for (const name of ["spawn__start_session", "memory_remember"]) {
      const io = makeIO();
      const frame = invokeFrame(runId, name, {});
      await reserveToolInvoke(frame, io);
      await executeToolInvoke(frame, io);
      expect(resultOf(toolResultFrames(io)[0]).result.isError ?? false).toBe(false);
    }
    // A PR-mutating tool invoked twice under the SAME envelope id merges once:
    // the receipt is the idempotency key that prevents a double side effect.
    const io = makeIO();
    const merge = invokeFrame(runId, "pr_merge", {});
    await reserveToolInvoke(merge, io);
    await executeToolInvoke(merge, io);
    const dupIo = makeIO();
    const dupMerge = invokeFrame(runId, "pr_merge", {}, { id: merge.id, seq: merge.seq, callId: merge.payload.callId });
    const reserved = await reserveToolInvoke(dupMerge, dupIo);
    expect(reserved.duplicate).toBe(true);
    expect(counter).toBe(1); // merged exactly once
  });
});
