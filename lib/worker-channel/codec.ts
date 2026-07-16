import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  handshakeFrameSchema,
  isKnownHandshakeType,
  transportFrameSchema,
  wireFrameSchema,
  workerCommandSchema,
  workerEventSchema,
  MAX_JSON_FRAME_BYTES,
  type HandshakeFrame,
  type TransportFrame,
  type WireFrame,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerEnvelope,
} from "./protocol";

export class WorkerChannelProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1002, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkerChannelProtocolError";
    this.closeCode = closeCode;
  }
}

type FrameData = string | Uint8Array | ArrayBuffer;

function frameBytes(data: FrameData): Uint8Array {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function frameText(data: FrameData): string {
  const bytes = frameBytes(data);
  if (bytes.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new WorkerChannelProtocolError(
      `Worker channel JSON frame exceeds ${MAX_JSON_FRAME_BYTES} bytes`,
      4413
    );
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Encode one validated JSON protocol frame. */
export function encodeFrame(frame: WireFrame): string {
  let validated: WireFrame;
  try {
    validated = wireFrameSchema.parse(frame) as WireFrame;
  } catch (error) {
    throw new WorkerChannelProtocolError("Invalid worker channel frame", 1002, { cause: error });
  }

  const encoded = JSON.stringify(validated);
  if (encoded === undefined) {
    throw new WorkerChannelProtocolError("Worker channel frame is not JSON serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_FRAME_BYTES) {
    throw new WorkerChannelProtocolError(
      `Worker channel JSON frame exceeds ${MAX_JSON_FRAME_BYTES} bytes`,
      4413
    );
  }
  return encoded;
}

/**
 * Decode exactly one UTF-8 JSON text frame. The size check happens before the
 * only JSON.parse call; Zod validation never parses JSON a second time.
 */
export function decodeFrame(data: FrameData): WireFrame {
  const text = frameText(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new WorkerChannelProtocolError("Worker channel frame is not valid JSON", 1002, { cause: error });
  }

  try {
    return wireFrameSchema.parse(parsed) as WireFrame;
  } catch (error) {
    throw new WorkerChannelProtocolError("Worker channel frame failed protocol validation", 1002, {
      cause: error,
    });
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 of the recursively key-sorted JSON payload, in lowercase hex. */
export function payloadSha256(frame: Pick<WorkerEnvelope, "payload">): string {
  const canonical = JSON.stringify(canonicalize(frame.payload));
  if (canonical === undefined) {
    throw new WorkerChannelProtocolError("Frame payload is not JSON serializable");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function isHandshakeFrame(frame: WireFrame): frame is HandshakeFrame {
  return isKnownHandshakeType(frame.type);
}

/** Fail closed when a frame is addressed to another run or worker instance. */
export function assertEnvelopeScope(
  frame: WireFrame,
  runId: number,
  instanceId: string
): asserts frame is Exclude<WireFrame, HandshakeFrame> {
  if (isHandshakeFrame(frame)) {
    throw new WorkerChannelProtocolError("Handshake frames do not carry an application scope", 4403);
  }
  if (frame.runId !== runId || frame.instanceId !== instanceId) {
    throw new WorkerChannelProtocolError("Worker channel run or instance scope mismatch", 4403);
  }
}

/** Validate sequence rules which are only meaningful after the handshake. */
export function assertPostHandshakeEnvelope(
  frame: WireFrame
): asserts frame is Exclude<WireFrame, HandshakeFrame> {
  if (isHandshakeFrame(frame)) {
    throw new WorkerChannelProtocolError("Handshake frame received after handshake", 4408);
  }
  if (isTransportFrame(frame)) {
    if (frame.seq !== 0) {
      throw new WorkerChannelProtocolError("Transport acknowledgements must use seq 0", 4408);
    }
    return;
  }
  if (frame.seq <= 0) {
    throw new WorkerChannelProtocolError("Post-handshake application frames must use seq > 0", 4408);
  }
}

export function isTransportFrame(frame: WireFrame): frame is TransportFrame {
  return frame.type === "channel.ack" || frame.type === "channel.nack";
}

export function isWorkerCommand(frame: WireFrame): frame is WorkerCommand {
  return (
    frame.type === "run.start" ||
    frame.type === "run.input" ||
    frame.type === "run.cancel" ||
    frame.type === "run.park" ||
    frame.type === "run.commit" ||
    frame.type === "tool.accepted" ||
    frame.type === "tool.progress" ||
    frame.type === "tool.result" ||
    frame.type === "channel.drain"
  );
}

export function isWorkerEvent(frame: WireFrame): frame is WorkerEvent {
  return (
    frame.type === "run.ready" ||
    frame.type === "run.phase" ||
    frame.type === "transcript.append" ||
    frame.type === "agent.event" ||
    frame.type === "tool.invoke" ||
    frame.type === "run.checkpoint" ||
    frame.type === "run.finished" ||
    frame.type === "run.failed" ||
    frame.type === "run.cancelled" ||
    frame.type === "worker.log"
  );
}

export { handshakeFrameSchema };
