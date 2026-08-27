import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { config as appConfig } from "@/lib/config";
import { localSocketPath } from "./dispatch-env";
import { decodeFrame, encodeFrame, WorkerChannelProtocolError } from "./codec";
import {
  CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT,
  CLOSE_CODE_CLEAN_DRAIN,
  CLOSE_CODE_FRAME_TOO_LARGE,
  CLOSE_CODE_PROTOCOL_MISMATCH,
  CLOSE_CODE_STALE_CONTROLLER_EPOCH,
  DEFAULT_DISCONNECT_GRACE_MS,
  MAX_JSON_FRAME_BYTES,
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type AcceptFrame,
  type ChannelAccept,
  type ChannelHello,
  type ChannelReject,
  type RunStart,
  type WireFrame,
  type WorkerEnvelope,
} from "./protocol";
import {
  channelCredentialSecret,
  mintChannelCredential,
  verifyChannelCredential,
} from "./credential";
import {
  WorkerSession,
  WorkerSessionProtocolError,
  type WorkerHandshakeState,
  type WorkerSessionAttachOptions,
  type WorkerSessionCommand,
  type WorkerSessionTransport,
} from "./worker-session";

const CHANNEL_PATH = "/worker/channel";
const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_BUILD = "unknown";
const DEFAULT_CLOSE_WAIT_MS = 5_000;
const DEFAULT_GRACE_MS = DEFAULT_DISCONNECT_GRACE_MS;

export type WorkerEndpoint =
  | string
  | { transport?: "unix" | "tcp"; socketPath?: string; host?: string; port?: number };

/**
 * Structural view of {@link WorkerSession} the supervisor depends on. The
 * session is the single owner of the durable outbox, worker-sequence
 * assignment, controller epoch fencing, replay, and ack/nack (plan section 9);
 * the supervisor only drives transport and hands it the accept payload.
 */
export interface WorkerSessionLike {
  /** Bind a controller transport and replay from its durable cursor. */
  attach(options: WorkerSessionAttachOptions): Promise<void>;
  /** Route a decoded controller command or transport frame into the session. */
  receive(frame: WireFrame): Promise<void>;
  /** Route one unsequenced binary blob chunk frame into the session. */
  receiveBinary?(frame: Buffer): Promise<void>;
  /** Append and stream a worker event; the session assigns its sequence. */
  emit(type: any, payload: any): Promise<WorkerEnvelope>;
  /** Numbers advertised in `channel.hello`. */
  handshakeState(): WorkerHandshakeState;
  /** Abort model work without discarding durable session state. */
  abort(reason?: string): void;
  /** Drain and release the durable spool. */
  close(): Promise<void>;
  /** Driver-facing helpers surfaced through {@link WorkerServer.session}. */
  waitForStart?(): Promise<RunStart>;
  /** Ordered controller-command iterator consumed by the ws run driver (section 13). */
  commands?(): AsyncIterable<WorkerSessionCommand>;
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
  workerBuild?: string;
  capabilities?: string[];
  acceptTimeoutMs?: number;
  disconnectGraceMs?: number;
  maxInFlightBytes?: number;
  /**
   * Dead-worker backstop: exit when NO controller has been attached for this
   * long. Armed as soon as the listener binds, disarmed while a controller is
   * attached, re-armed when one goes away. 0 (the DEFAULT here) disables it —
   * the entrypoint (scripts/run-worker.ts) opts in, so embedded servers and the
   * test suite can never be killed mid-use.
   *
   * This is the outer backstop, not a replacement for disconnectGraceMs: that
   * one aborts the SESSION 60s after a controller drops, this one guarantees the
   * PROCESS dies so the Machine stops billing. Run 169 idled indefinitely
   * because nothing covered "bound, but never dialed at all".
   */
  idleExitMs?: number;
  /** What to do when idleExitMs elapses. Defaults to a clean drain + exit(0).
   *  Injected by tests so nothing calls process.exit under vitest. */
  onIdleExit?: (reason: string) => void | Promise<void>;
  /** Override the protocol range advertised in `channel.hello`. Tests use it to
   * force a protocol mismatch; production always advertises the current major. */
  helloProtocol?: { min: number; max: number };
  /** Inject a session (tests, or a driver that owns the session lifecycle). */
  session?: WorkerSessionLike;
}

export interface WorkerServerCloseOptions {
  code?: number;
  reason?: string;
}

export interface WorkerServer {
  readonly httpServer: Server;
  readonly websocketServer: WebSocketServer;
  readonly session: WorkerSessionLike;
  readonly endpoint: string;
  readonly runId: number;
  readonly instanceId: string;
  emit(type: string, payload: unknown): Promise<WorkerEnvelope>;
  drain(reason?: string): Promise<void>;
  close(options?: WorkerServerCloseOptions): Promise<void>;
  address(): ReturnType<Server["address"]>;
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

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`);
  return result;
}

function safeReason(reason: string): string {
  return reason.slice(0, 123);
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
  const endpoint = config.endpoint ?? appConfig.worker.channelEndpoint;
  if (config.socketPath || (typeof endpoint === "string" && (endpoint.startsWith("/") || endpoint.startsWith("unix:")))) {
    // Accept both the listen form `unix:<abs path>` and the URL form
    // `unix://<abs path>`; the control plane dials the separate `ws+unix://` URL.
    const raw = config.socketPath ?? (typeof endpoint === "string" ? endpoint.replace(/^unix:(\/\/)?/, "") : undefined);
    const socketPath = raw ? decodeURIComponent(raw) : localSocketPath(config.instanceId);
    return { kind: "unix", socketPath };
  }
  if (typeof endpoint === "object" && endpoint !== null) {
    if (endpoint.transport === "unix" || endpoint.socketPath) {
      return { kind: "unix", socketPath: endpoint.socketPath ?? localSocketPath(config.instanceId) };
    }
    return { kind: "tcp", host: endpoint.host ?? "0.0.0.0", port: endpoint.port ?? 8787 };
  }
  if (typeof endpoint === "string" && (endpoint.startsWith("tcp://") || endpoint.startsWith("tcp:"))) {
    // Accept both the URL form `tcp://host:port` and the listen form
    // `tcp:host:port` — the latter is what dockerListenEndpoint emits (symmetric
    // with the `unix:` listen form handled above). Without the colon-form branch a Docker
    // default and bound a socket under the root-owned /app instead of TCP.
    const normalized = endpoint.startsWith("tcp://") ? endpoint : `tcp://${endpoint.slice("tcp:".length)}`;
    const parsed = new URL(normalized);
    // WHATWG URL keeps the brackets on an IPv6 literal ("[::]"), but
    // Server.listen() wants the bare address ("::"). Strip them.
    const hostname = parsed.hostname.replace(/^\[(.+)\]$/, "$1");
    return { kind: "tcp", host: hostname, port: Number(parsed.port || 8787) };
  }
  if (config.transport === "tcp" || config.port !== undefined) {
    return { kind: "tcp", host: config.host ?? "0.0.0.0", port: config.port ?? 8787 };
  }
  return {
    kind: "unix",
    socketPath: localSocketPath(config.instanceId),
  };
}

function formatEndpoint(address: ListenerAddress, server: Server): string {
  if (address.kind === "unix") return `unix://${address.socketPath}`;
  const value = server.address();
  if (value && typeof value === "object") return `tcp://${value.address}:${value.port}`;
  return `tcp://${address.host}:${address.port}`;
}

class WorkerServerImpl implements WorkerServer {
  readonly httpServer: Server;
  readonly websocketServer: WebSocketServer;
  readonly runId: number;
  readonly instanceId: string;
  endpoint: string;
  readonly session: WorkerSessionLike;

  private readonly config: WorkerServerConfig;
  private readonly listener: ListenerAddress;
  private readonly idleExitMs: number = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly acceptTimeoutMs: number;
  private readonly defaultGraceMs: number;
  private active?: ControllerConnection;
  private readonly connections = new Set<ControllerConnection>();
  private acceptTail: Promise<void> = Promise.resolve();
  private graceTimer?: NodeJS.Timeout;
  private started = false;
  private draining = false;
  private closed = false;
  private closePromise?: Promise<void>;

  private constructor(config: WorkerServerConfig, listener: ListenerAddress, session: WorkerSessionLike) {
    this.config = config;
    this.listener = listener;
    this.session = session;
    this.runId = config.runId;
    this.instanceId = config.instanceId;
    this.acceptTimeoutMs = positiveInteger(config.acceptTimeoutMs, DEFAULT_ACCEPT_TIMEOUT_MS, "acceptTimeoutMs");
    this.defaultGraceMs = positiveInteger(config.disconnectGraceMs, DEFAULT_GRACE_MS, "disconnectGraceMs");
    // 0 / absent => disabled. Deliberately opt-in; see WorkerServerConfig.idleExitMs.
    this.idleExitMs = Number.isFinite(config.idleExitMs) && (config.idleExitMs as number) > 0
      ? Math.floor(config.idleExitMs as number)
      : 0;
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
    const session =
      config.session ??
      (await WorkerSession.open({
        root,
        runId: config.runId,
        instanceId: config.instanceId,
        disconnectGraceMs: config.disconnectGraceMs,
        maxInFlightBytes: config.maxInFlightBytes,
      }));
    const server = new WorkerServerImpl(config, listener, session);
    await server.start();
    return server;
  }

  address(): ReturnType<Server["address"]> {
    return this.httpServer.address();
  }

  emit(type: string, payload: unknown): Promise<WorkerEnvelope> {
    return this.session.emit(type, payload);
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
    this.disarmIdleTimer();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const code = options.code ?? CLOSE_CODE_CLEAN_DRAIN;
    const reason = safeReason(options.reason ?? "worker server closed");
    for (const connection of [...this.connections]) this.closeConnection(connection, code, reason, true);
    await Promise.all([...this.connections].map((connection) => this.waitForClosed(connection, DEFAULT_CLOSE_WAIT_MS)));
    await this.session.close();
    await this.closeHttpServer();
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
    // Bound but never dialed is the run-169 hole: arm immediately.
    this.armIdleTimer();
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
    const state = this.session.handshakeState();
    const hello: ChannelHello = {
      protocol: this.config.helloProtocol ?? { min: WORKER_CHANNEL_PROTOCOL, max: WORKER_CHANNEL_PROTOCOL },
      workerBuild: this.config.workerBuild ?? appConfig.worker.build ?? DEFAULT_WORKER_BUILD,
      capabilities: this.config.capabilities ?? ["durable-spool"],
      lastControllerEpoch: state.lastControllerEpoch,
      lastAckedControlSeq: state.lastAckedControlSeq,
      nextWorkerSeq: state.nextWorkerSeq,
      pid: process.pid,
    };
    await this.queueSend(connection, {
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.hello",
      seq: 0,
      payload: hello,
    });
  }

  private async processMessage(connection: ControllerConnection, data: RawData, isBinary: boolean): Promise<void> {
    if (connection.closed) return;
    if (isBinary) {
      // Binary frames are blob chunk frames (unsequenced). They are only valid on
      // an accepted controller channel and are routed to the session's blob
      // receiver, whose bytes count toward the negotiated in-flight window.
      if (!connection.accepted) {
        throw new WorkerChannelProtocolError("binary blob chunk before channel.accept", 4408);
      }
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(rawDataToFrameData(data) as Uint8Array);
      if (this.session.receiveBinary) await this.session.receiveBinary(buffer);
      return;
    }
    const frame = decodeFrame(rawDataToFrameData(data));
    if (!connection.accepted) {
      if (frame.type !== "channel.accept") {
        await this.sendReject(connection, "malformed", "channel.accept is required before application frames");
        return this.closeConnection(connection, CLOSE_CODE_ACKNOWLEDGEMENT_TIMEOUT, "channel.accept required", false);
      }
      return this.acceptConnection(connection, frame);
    }
    // Post-handshake the session is the sole authority on scope, epoch fencing,
    // sequencing, and ack/nack. The supervisor just forwards the decoded frame.
    await this.session.receive(frame);
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
      return this.closeConnection(connection, CLOSE_CODE_PROTOCOL_MISMATCH, "protocol mismatch", false);
    }

    const transport: WorkerSessionTransport = {
      send: (frame) => this.queueSend(connection, frame),
      sendBinary: (data) => this.queueSend(connection, () => this.sendRawBinary(connection, data)),
      close: (code, reason) =>
        this.closeConnection(connection, code ?? CLOSE_CODE_CLEAN_DRAIN, reason ?? "worker session closed", false),
    };

    try {
      await this.session.attach({
        controllerEpoch: payload.controllerEpoch,
        lastAcceptedWorkerSeq: payload.lastAcceptedWorkerSeq,
        maxInFlightBytes: payload.maxInFlightBytes,
        transport,
      });
    } catch (error) {
      if (error instanceof WorkerSessionProtocolError && error.closeCode === CLOSE_CODE_STALE_CONTROLLER_EPOCH) {
        await this.sendReject(connection, "stale_epoch", "controller epoch is not newer than the fenced epoch");
        return this.closeConnection(connection, CLOSE_CODE_STALE_CONTROLLER_EPOCH, "stale controller epoch", false);
      }
      throw error;
    }

    const previous = this.active;
    connection.epoch = payload.controllerEpoch;
    connection.accepted = true;
    this.active = connection;
    this.disarmIdleTimer();
    if (connection.acceptTimer) clearTimeout(connection.acceptTimer);
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    // The session has fenced the older epoch; close its socket (transport duty).
    if (previous && previous !== connection) {
      previous.superseded = true;
      this.closeConnection(previous, CLOSE_CODE_STALE_CONTROLLER_EPOCH, "replaced by a newer controller epoch", false);
    }
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

  private async sendRawBinary(connection: ControllerConnection, data: Buffer): Promise<void> {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      connection.socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }

  private protocolFailure(connection: ControllerConnection, error: unknown): void {
    if (connection.closed) return;
    const protocolError =
      error instanceof WorkerChannelProtocolError || error instanceof WorkerSessionProtocolError ? error : undefined;
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


  /** Dead-worker backstop. See WorkerServerConfig.idleExitMs. */
  private armIdleTimer(): void {
    if (!this.idleExitMs || this.draining || this.closed) return;
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // Re-check: a controller may have attached between the last arm and now.
      if (this.active || this.draining || this.closed) return;
      void this.onIdleExpired();
    }, this.idleExitMs);
    // Never let this timer alone hold the process open.
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async onIdleExpired(): Promise<void> {
    const reason = `no controller attached for ${this.idleExitMs}ms`;
    this.logError("worker idle backstop firing; shutting down", new Error(reason));
    const handler = this.config.onIdleExit;
    if (handler) {
      await handler(reason);
      return;
    }
    // Drain so the spool is flushed, then exit ZERO. Fly's machine restart
    // policy is on-failure/max_retries=3: a non-zero exit here would RESTART the
    // Machine, re-bind, re-arm this very timer, and burn 4x the billing this is
    // meant to save.
    try {
      await this.close({ code: CLOSE_CODE_CLEAN_DRAIN, reason: "worker idle backstop" });
    } catch {
      // Never let a drain failure keep a dead worker (and its Machine) alive.
    }
    process.exit(0);
  }

  private handleConnectionClose(connection: ControllerConnection): void {
    connection.closed = true;
    if (connection.acceptTimer) clearTimeout(connection.acceptTimer);
    this.connections.delete(connection);
    if (this.active !== connection) return;
    this.active = undefined;
    // Re-arm the backstop: the session grace below only aborts the SESSION; this
    // guarantees the PROCESS eventually dies if no controller comes back.
    this.armIdleTimer();
    if (connection.superseded || this.draining || this.closed) return;
    const graceMs = this.defaultGraceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      if (this.active || this.draining || this.closed) return;
      this.session.abort("worker controller disconnect grace expired");
      void this.session.close();
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

  private logError(message: string, error: unknown): void {
    if (appConfig.worker.debugLog) {
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
