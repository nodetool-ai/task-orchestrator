import { z } from "zod";

/** The protocol major selected during the WebSocket handshake. */
export const WORKER_CHANNEL_PROTOCOL = 1 as const;
export const WORKER_CHANNEL_SUBPROTOCOL = "task-orchestrator.worker.v1" as const;

export const MAX_JSON_FRAME_BYTES = 1_048_576;
export const DEFAULT_MAX_IN_FLIGHT_BYTES = 8_388_608;
export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_DISCONNECT_GRACE_MS = 60_000;

/** WebSocket close codes owned by the worker channel protocol. */
export const WORKER_CHANNEL_CLOSE_CODES = {
  CLEAN_DRAIN: 1000,
  TRANSIENT_WORKER_ERROR: 1011,
  INVALID_INSTANCE_CREDENTIAL: 4401,
  SCOPE_MISMATCH: 4403,
  PROTOCOL_MISMATCH: 4406,
  ACKNOWLEDGEMENT_TIMEOUT: 4408,
  STALE_CONTROLLER_EPOCH: 4409,
  FRAME_TOO_LARGE: 4413,
} as const;

export const CLOSE_CODE_CLEAN_DRAIN = WORKER_CHANNEL_CLOSE_CODES.CLEAN_DRAIN;
export const CLOSE_CODE_TRANSIENT_WORKER_ERROR = WORKER_CHANNEL_CLOSE_CODES.TRANSIENT_WORKER_ERROR;
export const CLOSE_CODE_INVALID_INSTANCE_CREDENTIAL = WORKER_CHANNEL_CLOSE_CODES.INVALID_INSTANCE_CREDENTIAL;
export const CLOSE_CODE_SCOPE_MISMATCH = WORKER_CHANNEL_CLOSE_CODES.SCOPE_MISMATCH;
export const CLOSE_CODE_PROTOCOL_MISMATCH = WORKER_CHANNEL_CLOSE_CODES.PROTOCOL_MISMATCH;
export const CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT = WORKER_CHANNEL_CLOSE_CODES.ACKNOWLEDGEMENT_TIMEOUT;
export const CLOSE_CODE_STALE_CONTROLLER_EPOCH = WORKER_CHANNEL_CLOSE_CODES.STALE_CONTROLLER_EPOCH;
export const CLOSE_CODE_FRAME_TOO_LARGE = WORKER_CHANNEL_CLOSE_CODES.FRAME_TOO_LARGE;

const INSTANCE_ID_PATTERN = /^wi_[a-f0-9]{32}$/;

/** The common application envelope. Dates are strings on the wire. */
export interface WorkerEnvelope<T = unknown> {
  v: 1;
  type: string;
  id: string;
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  seq: number;
  sentAt: string;
  replyTo?: string;
  payload: T;
}

/** Snapshot fields intentionally stay extensible: additive database fields do
 * not require a protocol-major bump, while the identity fields anchor the
 * snapshot to the run represented by the channel. */
export interface RunSnapshot {
  id: number;
  status?: string;
  [key: string]: unknown;
}

export interface TaskSnapshot {
  id: string;
  [key: string]: unknown;
}

export interface PlanSnapshot {
  id: string;
  [key: string]: unknown;
}

export interface PersonaSnapshot {
  id: string;
  [key: string]: unknown;
}

export interface RepositorySnapshot {
  id: string;
  [key: string]: unknown;
}

export interface MessageSnapshot {
  id: number;
  runId?: number;
  role: "user" | "agent" | "tool" | "system";
  content: unknown[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface RunPolicy {
  allowedTools: string[];
  maxTurns: number | null;
  deadline: string | null;
}

export interface RunStart {
  mode: "start" | "resume";
  run: RunSnapshot;
  task: TaskSnapshot | null;
  plan: PlanSnapshot | null;
  persona: PersonaSnapshot;
  repository: RepositorySnapshot;
  transcript: MessageSnapshot[];
  inboxDigest: string | null;
  memoryContext: string;
  pendingInput: MessageSnapshot[];
  policy: RunPolicy;
}

export interface RunInput {
  messages: MessageSnapshot[];
}

export interface RunCancel {
  reason: string;
  requestId: string;
  deadline: string | null;
}

export interface RunPark {
  reason: string;
}

export type RunCommitStatus = "completed" | "failed" | "cancelled" | "closed" | "budget_exhausted";

export interface RunCommit {
  status: RunCommitStatus;
  result?: unknown;
  error?: string | null;
  prUrl?: string | null;
  usage?: UsageSnapshot;
}

export interface ToolAccepted {
  callId: string;
}

export interface ToolProgress {
  callId: string;
  progress: unknown;
  message?: string;
}

export interface ToolResult {
  callId: string;
  result: unknown;
  isError?: boolean;
}

/** Normalized tool result exposed to the worker runtime. */
export interface ToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ChannelDrain {
  reason?: string;
}

export interface RunReady {
  startId: string;
}

export interface RunPhase {
  phase: string;
  detail?: string;
}

export interface TranscriptAppend {
  message: MessageSnapshot;
}

export interface AgentEvent {
  event: unknown;
}

export interface ToolInvoke {
  callId: string;
  tool: string;
  arguments: unknown;
}

export interface RunCheckpoint {
  sdkSessionId: string | null;
  metadata?: unknown;
}

export interface UsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export interface RunFinished {
  result: unknown;
  usage?: UsageSnapshot;
  prUrl?: string | null;
}

export interface RunFailed {
  error: string;
  usage?: UsageSnapshot;
  result?: unknown;
}

export interface RunCancelled {
  requestId: string;
  reason?: string;
}

export interface WorkerLogEntry {
  level?: string;
  message: string;
  sentAt?: string;
}

export interface WorkerLog {
  entries: WorkerLogEntry[];
  droppedCount?: number;
}

export interface ChannelHello {
  protocol: { min: number; max: number };
  workerBuild: string;
  capabilities: string[];
  lastControllerEpoch: number;
  lastAckedControlSeq: number;
  nextWorkerSeq: number;
}

export interface ChannelAccept {
  protocol: 1;
  controllerEpoch: number;
  leaseId: string;
  lastAcceptedWorkerSeq: number;
  heartbeatMs: number;
  disconnectGraceMs: number;
  maxInFlightBytes: number;
}

export type ChannelRejectReason =
  | "protocol_mismatch"
  | "invalid_credential"
  | "scope_mismatch"
  | "stale_epoch"
  | "malformed";

export interface ChannelReject {
  reason: ChannelRejectReason;
  detail?: string;
}

export interface ChannelAck {
  throughSeq: number;
}

export interface ChannelNack {
  expectedSeq: number;
  reason?: "gap" | "invalid";
}

type TypedEnvelope<Type extends string, Payload> = Omit<WorkerEnvelope<Payload>, "type" | "payload"> & {
  type: Type;
  payload: Payload;
};

export type RunStartEnvelope = TypedEnvelope<"run.start", RunStart>;
export type RunInputEnvelope = TypedEnvelope<"run.input", RunInput>;
export type RunCancelEnvelope = TypedEnvelope<"run.cancel", RunCancel>;
export type RunParkEnvelope = TypedEnvelope<"run.park", RunPark>;
export type RunCommitEnvelope = TypedEnvelope<"run.commit", RunCommit>;
export type ToolAcceptedEnvelope = TypedEnvelope<"tool.accepted", ToolAccepted>;
export type ToolProgressEnvelope = TypedEnvelope<"tool.progress", ToolProgress>;
export type ToolResultEnvelope = TypedEnvelope<"tool.result", ToolResult>;
export type ChannelDrainEnvelope = TypedEnvelope<"channel.drain", ChannelDrain>;

export type WorkerCommand =
  | RunStartEnvelope
  | RunInputEnvelope
  | RunCancelEnvelope
  | RunParkEnvelope
  | RunCommitEnvelope
  | ToolAcceptedEnvelope
  | ToolProgressEnvelope
  | ToolResultEnvelope
  | ChannelDrainEnvelope;

export type RunReadyEnvelope = TypedEnvelope<"run.ready", RunReady>;
export type RunPhaseEnvelope = TypedEnvelope<"run.phase", RunPhase>;
export type TranscriptAppendEnvelope = TypedEnvelope<"transcript.append", TranscriptAppend>;
export type AgentEventEnvelope = TypedEnvelope<"agent.event", AgentEvent>;
export type ToolInvokeEnvelope = TypedEnvelope<"tool.invoke", ToolInvoke>;
export type RunCheckpointEnvelope = TypedEnvelope<"run.checkpoint", RunCheckpoint>;
export type RunFinishedEnvelope = TypedEnvelope<"run.finished", RunFinished>;
export type RunFailedEnvelope = TypedEnvelope<"run.failed", RunFailed>;
export type RunCancelledEnvelope = TypedEnvelope<"run.cancelled", RunCancelled>;
export type WorkerLogEnvelope = TypedEnvelope<"worker.log", WorkerLog>;

export type WorkerEvent =
  | RunReadyEnvelope
  | RunPhaseEnvelope
  | TranscriptAppendEnvelope
  | AgentEventEnvelope
  | ToolInvokeEnvelope
  | RunCheckpointEnvelope
  | RunFinishedEnvelope
  | RunFailedEnvelope
  | RunCancelledEnvelope
  | WorkerLogEnvelope;

export type ChannelAckEnvelope = TypedEnvelope<"channel.ack", ChannelAck>;
export type ChannelNackEnvelope = TypedEnvelope<"channel.nack", ChannelNack>;
export type TransportFrame = ChannelAckEnvelope | ChannelNackEnvelope;

export type HelloFrame = {
  v: 1;
  type: "channel.hello";
  seq: 0;
  payload: ChannelHello;
};
export type AcceptFrame = {
  v: 1;
  type: "channel.accept";
  seq: 0;
  payload: ChannelAccept;
};
export type RejectFrame = {
  v: 1;
  type: "channel.reject";
  seq: 0;
  payload: ChannelReject;
};

export type HandshakeFrame = HelloFrame | AcceptFrame | RejectFrame;
export type WireFrame = HandshakeFrame | WorkerCommand | WorkerEvent | TransportFrame;

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const isoDate = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const instanceId = z.string().regex(INSTANCE_ID_PATTERN);
const object = z.object({}).passthrough();
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ])
);

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    totalCostUsd: z.number().nonnegative().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    id: positiveInt,
    runId: positiveInt.optional(),
    role: z.enum(["user", "agent", "tool", "system"]),
    content: z.array(z.unknown()),
    createdAt: isoDate.optional(),
  })
  .passthrough();

const runSchema = z.object({ id: positiveInt }).passthrough();
const optionalSnapshot = z.union([object, z.null()]);
const requiredSnapshot = object;

const runStartSchema = z
  .object({
    mode: z.enum(["start", "resume"]),
    run: runSchema,
    task: optionalSnapshot,
    plan: optionalSnapshot,
    persona: requiredSnapshot,
    repository: requiredSnapshot,
    transcript: z.array(messageSchema),
    inboxDigest: z.string().nullable(),
    memoryContext: z.string(),
    pendingInput: z.array(messageSchema),
    policy: z.object({
      allowedTools: z.array(z.string()),
      maxTurns: z.number().int().positive().nullable(),
      deadline: isoDate.nullable(),
    }).passthrough(),
  })
  .passthrough();

const payloadSchemas = {
  "run.start": runStartSchema,
  "run.input": z.object({ messages: z.array(messageSchema).min(1) }).passthrough(),
  "run.cancel": z.object({
    reason: z.string().min(1),
    requestId: z.string().min(1),
    deadline: isoDate.nullable(),
  }).passthrough(),
  "run.park": z.object({ reason: z.string().min(1) }).passthrough(),
  "run.commit": z.object({
    status: z.enum(["completed", "failed", "cancelled", "closed", "budget_exhausted"]),
    result: z.unknown().optional(),
    error: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),
    usage: usageSchema.optional(),
  }).passthrough(),
  "tool.accepted": z.object({ callId: z.string().min(1) }).passthrough(),
  "tool.progress": z.object({ callId: z.string().min(1), progress: jsonValue, message: z.string().optional() }).passthrough(),
  "tool.result": z.object({ callId: z.string().min(1), result: jsonValue, isError: z.boolean().optional() }).passthrough(),
  "channel.drain": z.object({ reason: z.string().optional() }).passthrough(),
  "run.ready": z.object({ startId: z.string().min(1) }).passthrough(),
  "run.phase": z.object({ phase: z.string().min(1), detail: z.string().optional() }).passthrough(),
  "transcript.append": z.object({ message: messageSchema }).passthrough(),
  "agent.event": z.object({ event: jsonValue }).passthrough(),
  "tool.invoke": z.object({ callId: z.string().min(1), tool: z.string().min(1), arguments: jsonValue }).passthrough(),
  "run.checkpoint": z.object({ sdkSessionId: z.string().nullable(), metadata: jsonValue.optional() }).passthrough(),
  "run.finished": z.object({ result: jsonValue, usage: usageSchema.optional(), prUrl: z.string().nullable().optional() }).passthrough(),
  "run.failed": z.object({ error: z.string().min(1), usage: usageSchema.optional(), result: jsonValue.optional() }).passthrough(),
  "run.cancelled": z.object({ requestId: z.string().min(1), reason: z.string().optional() }).passthrough(),
  "worker.log": z.object({
    entries: z.array(z.object({ level: z.string().optional(), message: z.string(), sentAt: isoDate.optional() }).passthrough()),
    droppedCount: nonNegativeInt.optional(),
  }).passthrough(),
  "channel.ack": z.object({ throughSeq: positiveInt }).passthrough(),
  "channel.nack": z.object({ expectedSeq: positiveInt, reason: z.enum(["gap", "invalid"]).optional() }).passthrough(),
} as const;

const envelopeFields = {
  v: z.literal(WORKER_CHANNEL_PROTOCOL),
  id: uuid,
  runId: positiveInt,
  instanceId,
  controllerEpoch: nonNegativeInt,
  seq: nonNegativeInt,
  sentAt: isoDate,
  replyTo: uuid.optional(),
};

const envelope = <Type extends keyof typeof payloadSchemas>(type: Type) =>
  z.object({ ...envelopeFields, type: z.literal(type), payload: payloadSchemas[type] }).strict();

const postHandshakeEnvelope = <Type extends keyof typeof payloadSchemas>(type: Type) =>
  envelope(type).extend({ seq: positiveInt });

const transportEnvelope = <Type extends "channel.ack" | "channel.nack">(type: Type) =>
  envelope(type).extend({ seq: z.literal(0) });

const commandSchemas = [
  postHandshakeEnvelope("run.start"),
  postHandshakeEnvelope("run.input"),
  postHandshakeEnvelope("run.cancel"),
  postHandshakeEnvelope("run.park"),
  postHandshakeEnvelope("run.commit"),
  postHandshakeEnvelope("tool.accepted"),
  postHandshakeEnvelope("tool.progress"),
  postHandshakeEnvelope("tool.result"),
  postHandshakeEnvelope("channel.drain"),
] as const;

const eventSchemas = [
  postHandshakeEnvelope("run.ready"),
  postHandshakeEnvelope("run.phase"),
  postHandshakeEnvelope("transcript.append"),
  postHandshakeEnvelope("agent.event"),
  postHandshakeEnvelope("tool.invoke"),
  postHandshakeEnvelope("run.checkpoint"),
  postHandshakeEnvelope("run.finished"),
  postHandshakeEnvelope("run.failed"),
  postHandshakeEnvelope("run.cancelled"),
  postHandshakeEnvelope("worker.log"),
] as const;

const transportSchemas = [transportEnvelope("channel.ack"), transportEnvelope("channel.nack")] as const;

export const workerCommandSchema = z.discriminatedUnion("type", commandSchemas);
export const workerEventSchema = z.discriminatedUnion("type", eventSchemas);
export const transportFrameSchema = z.discriminatedUnion("type", transportSchemas);

const handshakeFrameSchema = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(WORKER_CHANNEL_PROTOCOL),
    type: z.literal("channel.hello"),
    seq: z.literal(0),
    payload: z.object({
      protocol: z.object({ min: positiveInt, max: positiveInt }).passthrough(),
      workerBuild: z.string().min(1),
      capabilities: z.array(z.string()),
      lastControllerEpoch: nonNegativeInt,
      lastAckedControlSeq: nonNegativeInt,
      nextWorkerSeq: positiveInt,
    }).passthrough(),
  }).strict(),
  z.object({
    v: z.literal(WORKER_CHANNEL_PROTOCOL),
    type: z.literal("channel.accept"),
    seq: z.literal(0),
    payload: z.object({
      protocol: z.literal(WORKER_CHANNEL_PROTOCOL),
      controllerEpoch: positiveInt,
      leaseId: z.string().min(1),
      lastAcceptedWorkerSeq: nonNegativeInt,
      heartbeatMs: positiveInt,
      disconnectGraceMs: positiveInt,
      maxInFlightBytes: positiveInt,
    }).passthrough(),
  }).strict(),
  z.object({
    v: z.literal(WORKER_CHANNEL_PROTOCOL),
    type: z.literal("channel.reject"),
    seq: z.literal(0),
    payload: z.object({
      reason: z.enum(["protocol_mismatch", "invalid_credential", "scope_mismatch", "stale_epoch", "malformed"]),
      detail: z.string().optional(),
    }).passthrough(),
  }).strict(),
]);

/** Schema used by the codec. It is exported for callers that need to validate
 * a frame without decoding a WebSocket payload. */
export const wireFrameSchema = z.union([
  handshakeFrameSchema,
  workerCommandSchema,
  workerEventSchema,
  transportFrameSchema,
]);

export { handshakeFrameSchema };

export function isKnownHandshakeType(type: string): type is HandshakeFrame["type"] {
  return type === "channel.hello" || type === "channel.accept" || type === "channel.reject";
}

export function isKnownTransportType(type: string): type is TransportFrame["type"] {
  return type === "channel.ack" || type === "channel.nack";
}

export { INSTANCE_ID_PATTERN };
