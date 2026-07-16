import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerSession } from "../lib/worker-channel/worker-session";
import type { WireFrame } from "../lib/worker-channel/protocol";

const runId = 41;
const instanceId = "wi_0123456789abcdef0123456789abcdef";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function session() {
  const root = await mkdtemp(join(tmpdir(), "worker-session-")); roots.push(root);
  return WorkerSession.open({ root, runId, instanceId, disconnectGraceMs: 20 });
}
function command(type: string, payload: unknown, seq: number, id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`): WireFrame {
  return { v: 1, type, id, runId, instanceId, controllerEpoch: 1, seq, sentAt: new Date().toISOString(), payload } as WireFrame;
}

describe("WorkerSession", () => {
  it("starts once, acknowledges commands, and aborts before yielding cancel", async () => {
    const sent: WireFrame[] = [];
    const value = await session();
    await value.attach({ controllerEpoch: 1, transport: { send: (frame) => { sent.push(frame); } } });
    await value.acceptCommand(command("run.start", { mode: "start", run: { id: runId }, task: null, plan: null, persona: { id: "p" }, repository: { id: "r" }, transcript: [], inboxDigest: null, memoryContext: "", pendingInput: [], policy: { allowedTools: [], maxTurns: null, deadline: null } }, 1) as never);
    expect((await value.waitForStart()).run.id).toBe(runId);
    await value.acceptCommand(command("run.cancel", { reason: "stop", requestId: "r", deadline: null }, 2) as never);
    expect(value.abortSignal.aborted).toBe(true);
    expect((await value.commands()[Symbol.asyncIterator]().next()).value).toMatchObject({ reason: "stop" });
    expect(sent.filter((frame) => frame.type === "channel.ack").at(-1)?.payload).toEqual({ throughSeq: 2 });
    await value.close();
  });
});
