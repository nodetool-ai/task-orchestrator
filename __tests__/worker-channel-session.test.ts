import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerSession } from "../lib/worker-channel/worker-session";
import { CLOSE_CODE_STALE_CONTROLLER_EPOCH } from "../lib/worker-channel/protocol";
import type { WireFrame } from "../lib/worker-channel/protocol";

const runId = 41;
const instanceId = "wi_0123456789abcdef0123456789abcdef";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function session() {
  const root = await mkdtemp(join(tmpdir(), "worker-session-")); roots.push(root);
  return WorkerSession.open({ root, runId, instanceId, disconnectGraceMs: 20 });
}

function sink() {
  const frames: WireFrame[] = [];
  return { frames, transport: { send: (frame: WireFrame) => { frames.push(frame); } } };
}

const startPayload = {
  mode: "start",
  run: { id: runId },
  task: null,
  plan: null,
  persona: { id: "p" },
  repository: { id: "r" },
  transcript: [],
  inboxDigest: null,
  memoryContext: "",
  pendingInput: [],
  policy: { allowedTools: [], maxTurns: null, deadline: null },
};

function command(
  type: string,
  payload: unknown,
  seq: number,
  epoch = 1,
  id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
): WireFrame {
  return { v: 1, type, id, runId, instanceId, controllerEpoch: epoch, seq, sentAt: new Date().toISOString(), payload } as WireFrame;
}

function ack(throughSeq: number, epoch = 1): WireFrame {
  return {
    v: 1,
    type: "channel.ack",
    id: `ack-${throughSeq}`,
    runId,
    instanceId,
    controllerEpoch: epoch,
    seq: 0,
    sentAt: new Date().toISOString(),
    payload: { throughSeq },
  } as WireFrame;
}

const seqs = (frames: WireFrame[]) =>
  frames.filter((frame) => frame.type === "agent.event").map((frame) => (frame as { seq: number }).seq);

describe("WorkerSession", () => {
  it("starts once, acknowledges commands, and aborts before yielding cancel", async () => {
    const a = sink();
    const value = await session();
    await value.attach({ controllerEpoch: 1, transport: a.transport });
    await value.acceptCommand(command("run.start", startPayload, 1) as never);
    expect((await value.waitForStart()).run.id).toBe(runId);
    await value.acceptCommand(command("run.cancel", { reason: "stop", requestId: "r", deadline: null }, 2) as never);
    expect(value.abortSignal.aborted).toBe(true);
    expect((await value.commands()[Symbol.asyncIterator]().next()).value).toMatchObject({ reason: "stop" });
    expect(a.frames.filter((frame) => frame.type === "channel.ack").at(-1)?.payload).toEqual({ throughSeq: 2 });
    await value.close();
  });

  it("fences a lower controller epoch; the same epoch may redial (its controller never expires)", async () => {
    const value = await session();
    const first = sink();
    await value.attach({ controllerEpoch: 2, transport: first.transport });
    // Same controller, half-open socket on our side: the redial replaces the connection.
    const second = sink();
    await value.attach({ controllerEpoch: 2, lastAcceptedWorkerSeq: 0, transport: second.transport });
    await value.emit("agent.event", { event: { kind: "checkpoint" } } as never);
    expect(seqs(second.frames)).toEqual([1]);
    expect(seqs(first.frames)).toEqual([]);
    await expect(value.attach({ controllerEpoch: 1, transport: sink().transport })).rejects.toMatchObject({
      closeCode: CLOSE_CODE_STALE_CONTROLLER_EPOCH,
    });
    await value.close();
  });

  it("takes over on a higher epoch and routes output to the new controller only", async () => {
    const first = sink();
    const second = sink();
    const value = await session();
    await value.attach({ controllerEpoch: 1, transport: first.transport });
    await value.emit("agent.event", { event: { kind: "checkpoint" } } as never);
    expect(seqs(first.frames)).toEqual([1]);

    // Higher epoch takes over; the session replays from the negotiated cursor.
    await value.attach({ controllerEpoch: 2, lastAcceptedWorkerSeq: 0, transport: second.transport });
    expect(seqs(second.frames)).toEqual([1]);

    await value.emit("agent.event", { event: { kind: "checkpoint" } } as never);
    expect(seqs(first.frames)).toEqual([1]);
    expect(seqs(second.frames)).toEqual([1, 2]);

    // A command stamped with the fenced epoch is rejected as stale.
    await expect(value.receive(command("run.input", { text: "x" }, 1, 1))).rejects.toMatchObject({
      closeCode: CLOSE_CODE_STALE_CONTROLLER_EPOCH,
    });
    await value.close();
  });

  it("acks cumulatively and replays only unacknowledged events after reconnect", async () => {
    const first = sink();
    const value = await session();
    await value.attach({ controllerEpoch: 1, transport: first.transport });
    await value.emit("agent.event", { event: { kind: "a" } } as never);
    await value.emit("agent.event", { event: { kind: "b" } } as never);
    expect(seqs(first.frames)).toEqual([1, 2]);

    // Cumulative ack through seq 1 drops it from the durable in-flight window.
    await value.receive(ack(1));

    const second = sink();
    await value.attach({ controllerEpoch: 2, lastAcceptedWorkerSeq: 1, transport: second.transport });
    expect(seqs(second.frames)).toEqual([2]);
    await value.close();
  });
});
