import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertEnvelopeScope,
  assertPostHandshakeEnvelope,
  decodeFrame,
  encodeFrame,
  isTransportFrame,
  isWorkerCommand,
  isWorkerEvent,
  payloadSha256,
} from "../lib/worker-channel/codec";
import {
  DEFAULT_DISCONNECT_GRACE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_IN_FLIGHT_BYTES,
  MAX_JSON_FRAME_BYTES,
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type WireFrame,
} from "../lib/worker-channel/protocol";

const INSTANCE_ID = "wi_0123456789abcdef0123456789abcdef";
const RUN_ID = 42;
const ID = "11111111-1111-4111-8111-111111111111";

function message(id = 1) {
  return { id, runId: RUN_ID, role: "user" as const, content: [{ type: "text", text: "hello" }] };
}

function frame(type: string, payload: unknown, seq = 1): WireFrame {
  return {
    v: 1,
    type,
    id: ID,
    runId: RUN_ID,
    instanceId: INSTANCE_ID,
    controllerEpoch: 3,
    seq,
    sentAt: "2026-07-15T10:00:00.000Z",
    payload,
  } as WireFrame;
}

const runStart = {
  mode: "start" as const,
  run: { id: RUN_ID, status: "preparing" },
  task: { id: "T-1" },
  plan: { id: "P-1" },
  persona: { id: "persona-1" },
  repository: { id: "repo-1" },
  transcript: [message()],
  inboxDigest: null,
  memoryContext: "",
  pendingInput: [message(2)],
  policy: { allowedTools: ["Read"], maxTurns: 10, deadline: null },
};

describe("worker channel protocol", () => {
  it("exports the fixed protocol constants and close-independent limits", () => {
    expect(WORKER_CHANNEL_PROTOCOL).toBe(1);
    expect(WORKER_CHANNEL_SUBPROTOCOL).toBe("task-orchestrator.worker.v1");
    expect(MAX_JSON_FRAME_BYTES).toBe(1_048_576);
    expect(DEFAULT_MAX_IN_FLIGHT_BYTES).toBe(8_388_608);
    expect(DEFAULT_HEARTBEAT_MS).toBe(10_000);
    expect(DEFAULT_DISCONNECT_GRACE_MS).toBe(60_000);
  });

  it("round-trips every command, event, and transport union member", () => {
    const cases: Array<[string, unknown]> = [
      ["run.start", runStart],
      ["run.input", { messages: [message()] }],
      ["run.cancel", { reason: "user_requested", requestId: ID, deadline: null }],
      ["run.park", { reason: "waiting" }],
      ["run.commit", { status: "completed", result: { ok: true } }],
      ["tool.accepted", { callId: "call-1" }],
      ["tool.progress", { callId: "call-1", progress: { completed: 1 } }],
      ["tool.result", { callId: "call-1", result: { content: [] } }],
      ["channel.drain", { reason: "committed" }],
      ["run.ready", { startId: ID }],
      ["run.phase", { phase: "running" }],
      ["transcript.append", { message: message() }],
      ["agent.event", { event: { subtype: "shell_started" } }],
      ["tool.invoke", { callId: "call-1", tool: "task_orch__list_tasks", arguments: {} }],
      ["run.checkpoint", { sdkSessionId: "sdk-1", metadata: { attempt: 1 } }],
      ["run.finished", { result: "done", usage: { inputTokens: 1 } }],
      ["run.failed", { error: "boom" }],
      ["run.cancelled", { requestId: ID }],
      ["worker.log", { entries: [{ level: "info", message: "ready" }] }],
      ["channel.ack", { throughSeq: 4 }],
      ["channel.nack", { expectedSeq: 4, reason: "gap" }],
    ];

    for (const [type, payload] of cases) {
      const input = frame(type, payload, type === "channel.ack" || type === "channel.nack" ? 0 : 1);
      const decoded = decodeFrame(encodeFrame(input));
      expect(decoded.type).toBe(type);
      if (type === "channel.ack" || type === "channel.nack") {
        expect(isTransportFrame(decoded)).toBe(true);
      } else if (type === "run.start" || type === "run.input" || type === "run.cancel" || type === "run.park" || type === "run.commit" || type === "tool.accepted" || type === "tool.progress" || type === "tool.result" || type === "channel.drain") {
        expect(isWorkerCommand(decoded)).toBe(true);
      } else {
        expect(isWorkerEvent(decoded)).toBe(true);
      }
    }
  });

  it("decodes each handshake member and rejects a handshake after it is complete", () => {
    const hello = decodeFrame(JSON.stringify({
      v: 1,
      type: "channel.hello",
      seq: 0,
      payload: {
        protocol: { min: 1, max: 1 },
        workerBuild: "git-sha",
        capabilities: ["durable-spool"],
        lastControllerEpoch: 2,
        lastAckedControlSeq: 4,
        nextWorkerSeq: 5,
      },
    }));
    expect(hello.type).toBe("channel.hello");

    const accept = decodeFrame(JSON.stringify({
      v: 1,
      type: "channel.accept",
      seq: 0,
      payload: {
        protocol: 1,
        controllerEpoch: 3,
        leaseId: ID,
        lastAcceptedWorkerSeq: 4,
        heartbeatMs: 10_000,
        disconnectGraceMs: 60_000,
        maxInFlightBytes: 8_388_608,
      },
    }));
    expect(accept.type).toBe("channel.accept");

    const reject = decodeFrame(JSON.stringify({
      v: 1,
      type: "channel.reject",
      seq: 0,
      payload: { reason: "protocol_mismatch" },
    }));
    expect(reject.type).toBe("channel.reject");
    expect(() => assertPostHandshakeEnvelope(hello)).toThrow(/after handshake/);
  });

  it("rejects unknown types, missing fields, and unknown envelope fields", () => {
    expect(() => decodeFrame(JSON.stringify(frame("run.unknown", {})))).toThrow(/validation/);
    expect(() => decodeFrame(JSON.stringify(frame("run.phase", {})))).toThrow(/validation/);
    expect(() => decodeFrame(JSON.stringify({ ...frame("run.phase", { phase: "running" }), extra: true }))).toThrow(/validation/);
    expect(() => decodeFrame(JSON.stringify({ ...frame("run.phase", { phase: "running" }), payload: null }))).toThrow(/validation/);
  });

  it("enforces the exact UTF-8 JSON frame byte limit before parsing", () => {
    const oversized = JSON.stringify("x".repeat(MAX_JSON_FRAME_BYTES));
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(MAX_JSON_FRAME_BYTES);
    expect(() => decodeFrame(oversized)).toThrow(/exceeds/);
  });

  it("fails closed for run and instance scope mismatches", () => {
    const decoded = decodeFrame(encodeFrame(frame("run.phase", { phase: "running" })));
    expect(() => assertEnvelopeScope(decoded, RUN_ID + 1, INSTANCE_ID)).toThrow(/scope mismatch/);
    expect(() => assertEnvelopeScope(decoded, RUN_ID, "wi_fedcba9876543210fedcba9876543210")).toThrow(/scope mismatch/);
    expect(() => assertEnvelopeScope(decoded, RUN_ID, INSTANCE_ID)).not.toThrow();
  });

  it("hashes payloads canonically with recursive object-key sorting", () => {
    const a = frame("agent.event", { z: { b: 2, a: 1 }, a: [{ y: 2, x: 1 }] });
    const b = frame("agent.event", { a: [{ x: 1, y: 2 }], z: { a: 1, b: 2 } });
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    expect(payloadSha256(a)).toBe(
      createHash("sha256").update('{"a":[{"x":1,"y":2}],"z":{"a":1,"b":2}}').digest("hex")
    );
    expect(payloadSha256(frame("agent.event", { a: [{ x: 2, y: 1 }] }))).not.toBe(payloadSha256(a));
  });

  it("requires seq 0 for acknowledgements and positive seq for applications", () => {
    const ack = decodeFrame(encodeFrame(frame("channel.ack", { throughSeq: 4 }, 0)));
    expect(isTransportFrame(ack)).toBe(true);
    expect(() => assertPostHandshakeEnvelope(ack)).not.toThrow();
    expect(() => decodeFrame(JSON.stringify(frame("channel.ack", { throughSeq: 4 }, 1)))).toThrow(/validation/);
    expect(() => decodeFrame(JSON.stringify(frame("run.phase", { phase: "running" }, 0)))).toThrow(/validation/);
  });

  it("ignores additive payload fields while keeping the envelope closed", () => {
    const decoded = decodeFrame(encodeFrame(frame("run.phase", { phase: "running", futureField: true })));
    expect(decoded.payload).toMatchObject({ phase: "running", futureField: true });
  });
});
