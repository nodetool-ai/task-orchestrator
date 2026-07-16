import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  assertEnvelopeScope,
  assertPostHandshakeEnvelope,
  decodeFrame,
  encodeFrame,
  isTransportFrame,
  isWorkerCommand,
  isWorkerEvent,
  WorkerChannelProtocolError,
} from "./codec";
import {
  CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT,
  CLOSE_CODE_CLEAN_DRAIN,
  CLOSE_CODE_FRAME_TOO_LARGE,
  CLOSE_CODE_INVALID_INSTANCE_CREDENTIAL,
  CLOSE_CODE_SCOPE_MISMATCH,
  CLOSE_CODE_STALE_CONTROLLER_EPOCH,
  DEFAULT_DISCONNECT_GRACE_MS,
  DEFAULT_MAX_IN_FLIGHT_BYTES,
  MAX_JSON_FRAME_BYTES,
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type AcceptFrame,
  type ChannelAccept,
  type ChannelHello,
  type ChannelReject,
  type ChannelAck,
  type ChannelNack,
  type RunCancel,
  type RunCommit,
  type RunInput,
  type RunPark,
  type RunStart,
  type ToolResult,
  type WorkerCommand,
  type WorkerEnvelope,
  type WorkerEvent,
  type WireFrame,
} from "./protocol";
import {
  channelCredentialSecret,
  mintChannelCredential,
  verifyChannelCredential,
} from "./credential";
import { WorkerOutbox, type WorkerEvent as SpoolEvent } from "./spool";

const CHANNEL_PATH = "/worker/channel";
const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_BUILD = "unknown";
const DEFAULT_CLOSE_WAIT_MS = 5_000;
const DEFAULT_GRACE_MS = DEFAULT_DISCONNECT_GRACE_MS;
const STATE_FILENAME = "worker-state.json";

type CommandPayload = RunInput | RunCancel | RunPark | RunCommit | ToolResult;
type WorkerEventType = WorkerEvent["type"];

export type WorkerEndpoint =
  | string
  | { transport?: "unix" | "tcp"; socketPath?: string; host?: string; port?: number };

export interface WorkerSessionContext {
  runId: number;
  instanceId: string;
  emit: (type: string, payload: unknown) => Promise<WorkerEnvelope>;
}

/**
 * Structural version of the worker-session draft.  The server does not
 * import the draft so a worker image can update the session implementation
 * independently; the documented methods are all that the supervisor needs.
 */
export interface WorkerSessionLike {
  waitForStart?(): Promise<RunStart>;
  commands?(): AsyncIterable<CommandPayload>;
  emit?(type: string, payload: unknown): Promise<WorkerEnvelope | void>;
  invokeTool?(tool: string, args: unknown, callId: string): Promise<unknown>;
  waitForCommit?(finishEventId: string): Promise<RunCommit>;
  readonly abortSignal?: AbortSignal;
  close?(): Promise<void>;
  /** Preferred delivery hook used by the worker-session implementation. */
  acceptCommand?(frame: WorkerCommand): Promise<void> | void;
  /** Compatibility hook for a draft that names the delivery method push. */
  pushCommand?(frame: WorkerCommand): Promise<void> | void;
  onDisconnect?(): Promise<void> | void;
  onReconnect?(): Promise<void> | void;
  abort?(reason?: string): void;
}

export interface WorkerServerConfig {
  runId: number;
  instanceId: string;
  /** Expected complete bearer token. `expectedCredential` is an alias. */
  credential?: string;
  expectedCredential?: string;
  /** Used when the token is derived rather than passed as a complete token. */
  credentialSecret?: string;
  endpoint?: WorkerEndpoint;
  /** Explicit listener options are useful for local loopback tests. */
  socketPath?: string;
  host?: string;
  port?: number;
  transport?: "unix" | "tcp";
  sessionRoot?: string;
  outboxRoot?: string;
  outbox?: WorkerOutbox;
  workerBuild?: string;
  capabilities?: string[];
  acceptTimeoutMs?: number;
  disconnectGraceMs?: number;
  maxInFlightBytes?: number;
  /** Supply the real worker-session draft from the run driver. */
  session?: WorkerSessionLike;
  createSession?: (context: WorkerSessionContext) => WorkerSessionLike | Promise<WorkerSessionLike>;
}

export interface WorkerServerCloseOptions {
  code?: number;
  reason?: string;
}

export interface WorkerServer {
  readonly httpServer: Server;
  readonly websocketServer: WebSocketServer;
  readonly session: WorkerSessionLike;
  readonly outbox: WorkerOutbox;
  readonly endpoint: string;
  readonly runId: number;
  readonly instanceId: string;
  emit(type: string, payload: unknown): Promise<WorkerEnvelope>;
  drain(reason?: string): Promise<void>;
  close(options?: WorkerServerCloseOptions): Promise<void>;
  address(): ReturnType<Server["address"]>;
}

interface PersistedSupervisorState {
  version: 1;
  runId: number;
  instanceId: string;
  controllerEpoch: number;
  lastAckedControlSeq: number;
  lastAckedWorkerSeq: number;
  commandReceipts: Record<string, string>;
}

interface ListenerAddress {
  kind: "unix" | "tcp";
  socketPath?: string;
  host?: string;
  port?: number;
}

interface ControllerConnection {
  socket: WebSocket;
  accepted: boolean;
  epoch: number;
  closed: boolean;
  superseded: boolean;
  accepting: boolean;
  acceptTimer?: NodeJS.Timeout;
  messageTail: Promise<void>;
  sendTail: Promise<void>;
}

interface AsyncWaiter<T> {
  resolve(value: IteratorResult<T>): void;
  reject(error: unknown): void;
}

/** A minimal default session for bootstrapping and protocol tests. */
class QueueWorkerSession implements WorkerSessionLike {
  readonly abortController = new AbortController();
  readonly abortSignal = this.abortController.signal;
  private readonly queue = new AsyncQueue<CommandPayload>();
  private start?: RunStart;
  private startId?: string;
  private startWaiters: Array<{ resolve: (start: RunStart) => void; reject: (error: unknown) => void }> = [];
  private readonly commandIds = new Map<string, string>();
  private closed = false;

  constructor(private readonly emitFrame: (type: string, payload: unknown) => Promise<WorkerEnvelope>) {}

  async waitForStart(): Promise<RunStart> {
    if (this.start) return this.start;
    return new Promise<RunStart>((resolve, reject) => this.startWaiters.push({ resolve, reject }));
  }

  commands(): AsyncIterable<CommandPayload> {
    return this.queue;
  }

  emit(type: string, payload: unknown): Promise<WorkerEnvelope> {
    return this.emitFrame(type, payload);
  }

  async acceptCommand(frame: WorkerCommand): Promise<void> {
    const fingerprint = frameFingerprint(frame);
    const prior = this.commandIds.get(frame.id);
    if (prior !== undefined) {
      if (prior !== fingerprint) throw new Error(`command ${frame.id} was replayed with different contents`);
      return;
    }
    this.commandIds.set(frame.id, fingerprint);

    if (frame.type === "run.start") {
      if (!this.start) {
        this.start = frame.payload;
        this.startId = frame.id;
        for (const waiter of this.startWaiters.splice(0)) waiter.resolve(this.start);
      } else if (this.startId !== frame.id) {
        throw new Error("worker received a second run.start for the same session");
      }
      return;
    }
    if (frame.type === "channel.drain") {
      await this.close();
      return;
    }
    if (frame.type === "run.cancel") this.abortController.abort(frame.payload.reason);
    if (
      frame.type === "run.input" ||
      frame.type === "run.cancel" ||
      frame.type === "run.park" ||
      frame.type === "run.commit" ||
      frame.type === "tool.result"
    ) {
      this.queue.push(frame.payload);
    }
  }

  async invokeTool(tool: string, args: unknown, callId: string): Promise<unknown> {
    await this.emitFrame("tool.invoke", { tool, arguments: args, callId });
    for await (const command of this.queue) {
      if ("callId" in command && command.callId === callId) return command;
    }
    throw new Error("worker session closed while waiting for tool result");
  }

  abort(reason = "worker channel grace period expired"): void {
    this.abortController.abort(reason);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort("worker session closed");
    this.queue.close();
    for (const waiter of this.startWaiters.splice(0)) waiter.reject(new Error("worker session closed"));
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<AsyncWaiter<T>> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ value: this.values.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`);
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function safeReason(reason: string): string {
  return reason.slice(0, 123);
}

function frameFingerprint(frame: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(frame)), "utf8").digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function hasUpgradeToken(value: string | string[] | undefined): boolean {
  const header = headerValue(value);
  return header !== undefined && header.split(",").some((token) => token.trim().toLowerCase() === "upgrade");
}

function rejectHttp(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  const reason = status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function rawDataToFrameData(data: RawData): string | Uint8Array | ArrayBuffer {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

async function removeOwnedSocket(socketPath: string): Promise<void> {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error(`Refusing to remove non-socket endpoint ${socketPath}`);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`Refusing to remove socket ${socketPath} owned by another uid`);
    }
    await unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseEndpoint(config: WorkerServerConfig): ListenerAddress {
  const endpoint = config.endpoint ?? process.env.TASK_ORCH_WORKER_CHANNEL_ENDPOINT;
  if (config.socketPath || (typeof endpoint === "string" && (endpoint.startsWith("/") || endpoint.startsWith("unix://")))) {
    const raw = config.socketPath ?? (typeof endpoint === "string" ? endpoint.replace(/^unix:\/\//, "") : undefined);
    const socketPath = raw ? decodeURIComponent(raw) : join(process.cwd(), ".worker-sockets", `${config.instanceId}.sock`);
    return { kind: "unix", socketPath };
  }
  if (typeof endpoint === "object" && endpoint !== null) {
    if (endpoint.transport === "unix" || endpoint.socketPath) {
      return { kind: "unix", socketPath: endpoint.socketPath ?? join(process.cwd(), ".worker-sockets", `${config.instanceId}.sock`) };
    }
    return { kind: "tcp", host: endpoint.host ?? "0.0.0.0", port: endpoint.port ?? 8787 };
  }
  if (typeof endpoint === "string" && endpoint.startsWith("tcp://")) {
    const parsed = new URL(endpoint);
    return { kind: "tcp", host: parsed.hostname, port: Number(parsed.port || 8787) };
  }
  if (config.transport === "tcp" || config.port !== undefined || process.env.FLY_APP_NAME) {
    return { kind: "tcp", host: config.host ?? "0.0.0.0", port: config.port ?? 8787 };
  }
  return {
    kind: "unix",
    socketPath: join(process.cwd(), ".worker-sockets", `${config.instanceId}.sock`),
  };
}

function formatEndpoint(address: ListenerAddress, server: Server): string {
  if (address.kind === "unix") return `unix://${address.socketPath}`;
  const value = server.address();
  if (value && typeof value === "object") return `tcp://${value.address}:${value.port}`;
  return `tcp://${address.host}:${address.port}`;
}

async function syncFile(path: string, contents: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function loadSupervisorState(path: string, runId: number, instanceId: string): Promise<PersistedSupervisorState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PersistedSupervisorState>;
    if (parsed.version !== 1 || parsed.runId !== runId || parsed.instanceId !== instanceId) {
      throw new Error("worker supervisor state scope mismatch");
    }
    return {
      version: 1,
      runId,
      instanceId,
      controllerEpoch: nonNegativeInteger(parsed.controllerEpoch, "controllerEpoch"),
      lastAckedControlSeq: nonNegativeInteger(parsed.lastAckedControlSeq, "lastAckedControlSeq"),
      lastAckedWorkerSeq: nonNegativeInteger(parsed.lastAckedWorkerSeq, "lastAckedWorkerSeq"),
      commandReceipts: parsed.commandReceipts && typeof parsed.commandReceipts === "object"
        ? { ...parsed.commandReceipts }
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: 1,
      runId,
      instanceId,
      controllerEpoch: 0,
      lastAckedControlSeq: 0,
      lastAckedWorkerSeq: 0,
      commandReceipts: {},
    };
  }
}

class WorkerServerImpl implements WorkerServer {
  readonly httpServer: Server;
  readonly websocketServer: WebSocketServer;
  readonly runId: number;
  readonly instanceId: string;
  readonly outbox: WorkerOutbox;
  endpoint: string;
  readonly session: WorkerSessionLike;

  private readonly config: WorkerServerConfig;
  private readonly listener: ListenerAddress;
  private readonly statePath: string;
  private state: PersistedSupervisorState;
  private readonly acceptTimeoutMs: number;
  private readonly defaultGraceMs: number;
  private active?: ControllerConnection;
  private readonly connections = new Set<ControllerConnection>();
  private acceptTail: Promise<void> = Promise.resolve();
  private eventTail: Promise<void> = Promise.resolve();
  private graceTimer?: NodeJS.Timeout;
  private started = false;
  private draining = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(
    config: WorkerServerConfig,
    listener: ListenerAddress,
    outbox: WorkerOutbox,
    state: PersistedSupervisorState,
    statePath: string,
    session: WorkerSessionLike,
  ) {
    this.config = config;
    this.listener = listener;
    this.outbox = outbox;
    this.state = state;
    this.statePath = statePath;
    this.session = session;
    this.runId = config.runId;
    this.instanceId = config.instanceId;
    this.acceptTimeoutMs = positiveInteger(config.acceptTimeoutMs, DEFAULT_ACCEPT_TIMEOUT_MS, "acceptTimeoutMs");
    this.defaultGraceMs = positiveInteger(config.disconnectGraceMs, DEFAULT_GRACE_MS, "disconnectGraceMs");
    this.endpoint = listener.kind === "unix" ? `unix://${listener.socketPath}` : `tcp://${listener.host}:${listener.port}`;

    this.websocketServer = new WebSocketServer({
      noServer: true,
      // Leave a small margin for ws to deliver a frame to our codec, which
      // owns the protocol-specific 4413 close code.
      maxPayload: MAX_JSON_FRAME_BYTES + 1024,
    });
    this.httpServer = createServer((_request, response) => {
      response.statusCode = 404;
      response.setHeader("Content-Length", "0");
      response.end();
    });
    this.httpServer.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.websocketServer.on("connection", (socket) => this.handleConnection(socket));
    this.websocketServer.on("error", (error) => {
      if (!this.draining) this.logError("worker websocket server error", error);
    });
  }

  static async create(config: WorkerServerConfig): Promise<WorkerServerImpl> {
    if (!Number.isSafeInteger(config.runId) || config.runId <= 0) throw new TypeError("runId must be a positive integer");
    if (!/^wi_[a-f0-9]{32}$/.test(config.instanceId)) throw new TypeError("instanceId is invalid");
    const listener = parseEndpoint(config);
    const root = config.outboxRoot ?? config.sessionRoot ?? process.env.SESSION_ROOT ?? process.cwd();
    const statePath = join(root, "channel", STATE_FILENAME);
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
    const state = await loadSupervisorState(statePath, config.runId, config.instanceId);
    const outbox = config.outbox ?? await WorkerOutbox.open(root, config.runId, config.instanceId, {
      maxInFlightBytes: config.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
    });
    let server: WorkerServerImpl;
    const emit = (type: string, payload: unknown) => {
      if (!server) throw new Error("worker server is not initialized");
      return server.emitUntyped(type, payload);
    };
    const session = config.session ?? (config.createSession
      ? await config.createSession({ runId: config.runId, instanceId: config.instanceId, emit })
      : new QueueWorkerSession(emit));
    server = new WorkerServerImpl(config, listener, outbox, state, statePath, session);
    await server.start();
    return server;
  }

  address(): ReturnType<Server["address"]> {
    return this.httpServer.address();
  }

  emit(type: string, payload: unknown): Promise<WorkerEnvelope> {
    return this.emitUntyped(type, payload);
  }

  private emitUntyped(type: string, payload: unknown): Promise<WorkerEnvelope> {
    const run = this.eventTail.then(async () => {
      if (!isWorkerEvent({ type } as unknown as WireFrame)) throw new Error(`Cannot emit non-worker event ${type}`);
      const epoch = this.active?.accepted ? this.active.epoch : this.state.controllerEpoch;
      const frame: WorkerEvent = {
        v: WORKER_CHANNEL_PROTOCOL,
        type,
        id: randomUUID(),
        runId: this.runId,
        instanceId: this.instanceId,
        controllerEpoch: epoch,
        seq: this.outbox.nextSeq(),
        sentAt: new Date().toISOString(),
        payload,
      } as WorkerEvent;
      await this.outbox.append(frame as SpoolEvent);
      const current = this.active;
      if (current?.accepted && !current.closed) await this.queueSend(current, frame);
      return frame as WorkerEnvelope;
    });
    this.eventTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async drain(reason = "worker drain"): Promise<void> {
    await this.close({ code: CLOSE_CODE_CLEAN_DRAIN, reason });
  }

  async close(options: WorkerServerCloseOptions = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose(options);
    return this.closePromise;
  }

  private async performClose(options: WorkerServerCloseOptions): Promise<void> {
    this.draining = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const code = options.code ?? CLOSE_CODE_CLEAN_DRAIN;
    const reason = safeReason(options.reason ?? "worker server closed");
    for (const connection of [...this.connections]) this.closeConnection(connection, code, reason, true);
    await Promise.all([...this.connections].map((connection) => this.waitForClosed(connection, DEFAULT_CLOSE_WAIT_MS)));
    await this.eventTail.catch(() => undefined);
    await this.session.close?.();
    await this.closeHttpServer();
    await this.outbox.close();
    if (this.listener.kind === "unix" && this.listener.socketPath) {
      await removeOwnedSocket(this.listener.socketPath).catch(() => undefined);
    }
    this.closed = true;
  }

  private async start(): Promise<void> {
    if (this.started) return;
    if (this.listener.kind === "unix" && this.listener.socketPath) {
      await mkdir(dirname(this.listener.socketPath), { recursive: true, mode: 0o700 });
      await removeOwnedSocket(this.listener.socketPath);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      if (this.listener.kind === "unix") this.httpServer.listen(this.listener.socketPath);
      else this.httpServer.listen(this.listener.port, this.listener.host);
    });
    if (this.listener.kind === "unix" && this.listener.socketPath) await chmod(this.listener.socketPath, 0o600);
    this.started = true;
    (this as { endpoint: string }).endpoint = formatEndpoint(this.listener, this.httpServer);
  }

  private async closeHttpServer(): Promise<void> {
    if (!this.started) return;
    await new Promise<void>((resolve) => {
      this.httpServer.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          this.logError("worker HTTP listener close error", error);
        }
        resolve();
      });
    });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (request.url !== CHANNEL_PATH || request.method !== "GET") return rejectHttp(socket, 404);
    if (!hasUpgradeToken(request.headers.connection) || headerValue(request.headers.upgrade)?.toLowerCase() !== "websocket") {
      return rejectHttp(socket, 400);
    }
    const protocols = headerValue(request.headers["sec-websocket-protocol"]);
    const requestedProtocols = protocols?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (requestedProtocols.length !== 1 || requestedProtocols[0] !== WORKER_CHANNEL_SUBPROTOCOL) {
      return rejectHttp(socket, 400);
    }
    const authorization = headerValue(request.headers.authorization);
    const tokenMatch = authorization?.match(/^Bearer ([^\s]+)$/i);
    if (!tokenMatch || !this.validCredential(tokenMatch[1])) return rejectHttp(socket, 401);

    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.websocketServer.emit("connection", websocket, request);
    });
  }

  private validCredential(token: string): boolean {
    const expected = this.config.expectedCredential ?? this.config.credential;
    if (expected !== undefined) return constantTimeEqual(expected, token);
    try {
      return verifyChannelCredential(token, this.runId, this.instanceId, {
        secret: this.config.credentialSecret,
      }).ok;
    } catch {
      return false;
    }
  }

  private handleConnection(socket: WebSocket): void {
    const connection: ControllerConnection = {
      socket,
      accepted: false,
      epoch: 0,
      closed: false,
      superseded: false,
      accepting: false,
      messageTail: Promise.resolve(),
      sendTail: Promise.resolve(),
    };
    this.connections.add(connection);
    connection.acceptTimer = setTimeout(() => {
      if (!connection.accepted && !connection.closed) {
        void this.sendReject(connection, "malformed", "channel.accept was not received in time");
        this.closeConnection(connection, CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT, "channel.accept timeout", false);
      }
    }, this.acceptTimeoutMs);
    socket.on("message", (data, isBinary) => {
      connection.messageTail = connection.messageTail
        .then(() => this.processMessage(connection, data, isBinary))
        .catch((error) => this.protocolFailure(connection, error));
    });
    socket.on("error", (error) => {
      const code = (error as { code?: string }).code;
      if (code !== "WS_ERR_UNEXPECTED_RSV_1") this.logError("worker websocket connection error", error);
    });
    socket.on("close", () => this.handleConnectionClose(connection));
    void this.sendHello(connection).catch((error) => this.protocolFailure(connection, error));
  }

  private async sendHello(connection: ControllerConnection): Promise<void> {
    const hello: ChannelHello = {
      protocol: { min: WORKER_CHANNEL_PROTOCOL, max: WORKER_CHANNEL_PROTOCOL },
      workerBuild: this.config.workerBuild ?? process.env.TASK_ORCH_WORKER_BUILD ?? DEFAULT_WORKER_BUILD,
      capabilities: this.config.capabilities ?? ["durable-spool"],
      lastControllerEpoch: this.state.controllerEpoch,
      lastAckedControlSeq: this.state.lastAckedControlSeq,
      nextWorkerSeq: this.outbox.nextSeq(),
    };
    await this.sendRaw(connection, {
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.hello",
      seq: 0,
      payload: hello,
    });
  }

  private processMessage(connection: ControllerConnection, data: RawData, isBinary: boolean): Promise<void> {
    return this.processMessageInner(connection, data, isBinary);
  }

  private async processMessageInner(connection: ControllerConnection, data: RawData, isBinary: boolean): Promise<void> {
    if (connection.closed) return;
    if (isBinary) throw new WorkerChannelProtocolError("Worker channel only accepts JSON text frames", 1002);
    let frame: WireFrame;
    try {
      frame = decodeFrame(rawDataToFrameData(data));
    } catch (error) {
      throw error;
    }
    if (!connection.accepted) {
      if (frame.type !== "channel.accept") {
        await this.sendReject(connection, "malformed", "channel.accept is required before application frames");
        return this.closeConnection(connection, CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT, "channel.accept required", false);
      }
      return this.acceptConnection(connection, frame);
    }

    assertPostHandshakeEnvelope(frame);
    assertEnvelopeScope(frame, this.runId, this.instanceId);
    if (frame.controllerEpoch !== connection.epoch) {
      await this.sendReject(connection, "stale_epoch", "controller epoch is fenced");
      return this.closeConnection(connection, CLOSE_CODE_STALE_CONTROLLER_EPOCH, "stale controller epoch", false);
    }
    if (isTransportFrame(frame)) return this.processTransportFrame(connection, frame);
    if (isWorkerEvent(frame)) throw new WorkerChannelProtocolError("Worker event sent by controller", 1002);
    if (isWorkerCommand(frame)) return this.processCommand(connection, frame);
    throw new WorkerChannelProtocolError("Unknown worker channel frame direction", 1002);
  }

  private acceptConnection(connection: ControllerConnection, frame: AcceptFrame): Promise<void> {
    connection.accepting = true;
    const accepted = this.acceptTail.then(() => this.acceptConnectionInner(connection, frame.payload));
    this.acceptTail = accepted.catch(() => undefined);
    return accepted;
  }

  private async acceptConnectionInner(connection: ControllerConnection, payload: ChannelAccept): Promise<void> {
    if (connection.closed) return;
    if (payload.protocol !== WORKER_CHANNEL_PROTOCOL) {
      await this.sendReject(connection, "protocol_mismatch", "unsupported protocol major");
      return this.closeConnection(connection, 4406, "protocol mismatch", false);
    }
    const epoch = payload.controllerEpoch;
    if (epoch <= this.state.controllerEpoch || (this.active?.accepted && this.active !== connection && epoch <= this.active.epoch)) {
      await this.sendReject(connection, "stale_epoch", "controller epoch is not newer than the fenced epoch");
      return this.closeConnection(connection, CLOSE_CODE_STALE_CONTROLLER_EPOCH, "stale controller epoch", false);
    }

    const previous = this.active;
    connection.epoch = epoch;
    connection.accepted = true;
    this.active = connection;
    if (connection.acceptTimer) clearTimeout(connection.acceptTimer);
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    if (epoch > this.state.controllerEpoch) {
      this.state.controllerEpoch = epoch;
      this.state.lastAckedControlSeq = 0;
      this.state.commandReceipts = {};
    }
    await this.persistState();
    if (previous && previous !== connection) {
      previous.superseded = true;
      this.closeConnection(previous, CLOSE_CODE_STALE_CONTROLLER_EPOCH, "replaced by a newer controller epoch", false);
    }
    this.outbox.setMaxInFlightBytes(payload.maxInFlightBytes);
    await this.session.onReconnect?.();
    await this.queueSend(connection, async () => {
      const replay = await this.outbox.listAfter(payload.lastAcceptedWorkerSeq);
      for (const event of replay) await this.sendRaw(connection, event as unknown as WireFrame);
    });
  }

  private async processTransportFrame(
    connection: ControllerConnection,
    frame: Extract<WireFrame, { type: "channel.ack" | "channel.nack" }>,
  ): Promise<void> {
    if (frame.type === "channel.ack") {
      const payload = frame.payload as ChannelAck;
      await this.outbox.ackThrough(payload.throughSeq);
      this.state.lastAckedWorkerSeq = Math.max(this.state.lastAckedWorkerSeq, payload.throughSeq);
      await this.persistState();
      return;
    }
    const payload = frame.payload as ChannelNack;
    if (payload.reason === "invalid") throw new WorkerChannelProtocolError("Controller rejected worker replay", CLOSE_CODE_SCOPE_MISMATCH);
    await this.queueSend(connection, async () => {
      const replay = await this.outbox.listAfter(payload.expectedSeq - 1);
      for (const event of replay) await this.sendRaw(connection, event as unknown as WireFrame);
    });
  }

  private async processCommand(connection: ControllerConnection, frame: WorkerCommand): Promise<void> {
    const expected = this.state.lastAckedControlSeq + 1;
    const key = `${connection.epoch}:${frame.seq}`;
    const fingerprint = frameFingerprint(frame);
    if (frame.seq <= this.state.lastAckedControlSeq) {
      const prior = this.state.commandReceipts[key];
      if (prior !== undefined && prior !== fingerprint) {
        throw new WorkerChannelProtocolError("replayed command differs from the acknowledged command", CLOSE_CODE_SCOPE_MISMATCH);
      }
      await this.sendCommandAck(connection, frame.seq);
      return;
    }
    if (frame.seq !== expected) {
      await this.sendCommandNack(connection, expected);
      return;
    }
    await this.deliverCommand(frame);
    this.state.commandReceipts[key] = fingerprint;
    this.state.lastAckedControlSeq = frame.seq;
    await this.persistState();
    await this.sendCommandAck(connection, frame.seq);
    if (frame.type === "channel.drain") await this.drain(frame.payload.reason ?? "controller requested drain");
  }

  private async deliverCommand(frame: WorkerCommand): Promise<void> {
    if (this.session.acceptCommand) return this.session.acceptCommand(frame);
    if (this.session.pushCommand) return this.session.pushCommand(frame);
    throw new Error("worker session does not expose a command delivery hook");
  }

  private async sendCommandAck(connection: ControllerConnection, throughSeq: number): Promise<void> {
    const frame = {
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.ack" as const,
      id: randomUUID(),
      runId: this.runId,
      instanceId: this.instanceId,
      controllerEpoch: connection.epoch,
      seq: 0,
      sentAt: new Date().toISOString(),
      payload: { throughSeq },
    } as unknown as WireFrame;
    await this.queueSend(connection, frame);
  }

  private async sendCommandNack(connection: ControllerConnection, expectedSeq: number): Promise<void> {
    const frame = {
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.nack" as const,
      id: randomUUID(),
      runId: this.runId,
      instanceId: this.instanceId,
      controllerEpoch: connection.epoch,
      seq: 0,
      sentAt: new Date().toISOString(),
      payload: { expectedSeq, reason: "gap" },
    } as unknown as WireFrame;
    await this.queueSend(connection, frame);
  }

  private async sendReject(
    connection: ControllerConnection,
    reason: ChannelReject["reason"],
    detail: string,
  ): Promise<void> {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    await this.sendRaw(connection, {
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.reject",
      seq: 0,
      payload: { reason, detail },
    });
  }

  private queueSend(connection: ControllerConnection, frame: WireFrame | (() => Promise<void>)): Promise<void> {
    const next = connection.sendTail.then(async () => {
      if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
      if (typeof frame === "function") return frame();
      await this.sendRaw(connection, frame);
    });
    connection.sendTail = next.catch(() => undefined);
    return next;
  }

  private async sendRaw(connection: ControllerConnection, frame: WireFrame): Promise<void> {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    const encoded = encodeFrame(frame);
    await new Promise<void>((resolve, reject) => {
      connection.socket.send(encoded, (error) => (error ? reject(error) : resolve()));
    });
  }

  private protocolFailure(connection: ControllerConnection, error: unknown): void {
    if (connection.closed) return;
    const protocolError = error instanceof WorkerChannelProtocolError ? error : undefined;
    const code = protocolError?.closeCode ?? (String(error).includes("larger") ? CLOSE_CODE_FRAME_TOO_LARGE : 1011);
    this.logError("worker channel protocol failure", error);
    void this.sendReject(connection, "malformed", protocolError?.message ?? "worker channel protocol failure")
      .catch(() => undefined)
      .finally(() => this.closeConnection(connection, code, protocolError?.message ?? "protocol failure", false));
  }

  private closeConnection(connection: ControllerConnection, code: number, reason: string, notify = true): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.acceptTimer) clearTimeout(connection.acceptTimer);
    if (!notify) connection.superseded = true;
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      try {
        connection.socket.close(code, safeReason(reason));
      } catch {
        connection.socket.terminate();
      }
    } else {
      connection.socket.terminate();
    }
  }

  private handleConnectionClose(connection: ControllerConnection): void {
    connection.closed = true;
    if (connection.acceptTimer) clearTimeout(connection.acceptTimer);
    this.connections.delete(connection);
    if (this.active !== connection) return;
    this.active = undefined;
    if (connection.superseded || this.draining || this.closed) return;
    void this.session.onDisconnect?.();
    const graceMs = this.defaultGraceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (this.active || this.draining || this.closed) return;
      this.session.abort?.("worker controller disconnect grace expired");
      void this.session.close?.();
    }, graceMs);
  }

  private waitForClosed(connection: ControllerConnection, timeoutMs: number): Promise<void> {
    if (connection.closed && connection.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      connection.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async persistState(): Promise<void> {
    const temporary = `${this.statePath}.tmp`;
    await syncFile(temporary, `${JSON.stringify(this.state)}\n`);
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600);
    await syncDirectory(dirname(this.statePath));
  }

  private logError(message: string, error: unknown): void {
    if (process.env.TASK_ORCH_LOG_LEVEL === "debug") {
      console.error(`[worker-channel] ${message}`, error);
    }
  }
}

/** Start a private worker supervisor and its upgrade-only HTTP listener. */
export async function startWorkerServer(config: WorkerServerConfig): Promise<WorkerServer> {
  return WorkerServerImpl.create(config);
}

/** Alias kept for scripts that prefer a factory-style name. */
export const createWorkerServer = startWorkerServer;

/** Derive the expected credential for run-worker integration without exposing
 * the signing secret to the session or model subprocess. */
export function expectedWorkerCredential(runId: number, instanceId: string, secret?: string): string {
  if (secret !== undefined) return mintChannelCredential(runId, instanceId, { secret });
  return mintChannelCredential(runId, instanceId, { secret: channelCredentialSecret() });
}
