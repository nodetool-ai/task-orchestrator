import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import {
  assertEnvelopeScope,
  decodeFrame,
  encodeFrame,
  isBlobControlFrame,
  isTransportFrame,
  isWorkerEvent,
} from "./codec";
import { BlobCoordinator, collectBlobRefs, type BlobWireIO } from "./blob-transfer";
import { mintChannelCredential } from "./credential";
import {
  ackCommandsThrough,
  acquireControllerLease,
  applyWorkerEvent,
  getCommand,
  getWorkerObservationTarget,
  getLastAcceptedWorkerSeq,
  listPendingCommands,
  markChannelConnected,
  persistWorkerIncarnation,
  persistCommand,
  rebasePendingCommands,
  releaseControllerLease,
  touchChannel,
  type CommandRow,
  type WorkerEventHandler,
} from "./repository";
import {
  CLOSE_CODE_PROTOCOL_MISMATCH,
  CLOSE_CODE_SCOPE_MISMATCH,
  CLOSE_CODE_STALE_CONTROLLER_EPOCH,
  DEFAULT_DISCONNECT_GRACE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MAX_IN_FLIGHT_BYTES,
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type BlobAcceptedMessage,
  type BlobOpenMessage,
  type BlobRejectedMessage,
  type BlobRef,
  type ChannelHello,
  type ToolInvokeEnvelope,
  type WorkerCommand,
  type WorkerEnvelope,
  type WorkerEvent,
  type WireFrame,
} from "./protocol";
import { executeToolInvoke, reserveToolInvoke, sweepOrphanedToolInvokes, type ToolChannelIO } from "./tool-invoke";

import { config } from "../config";
import { isSpritesDialEndpoint, parseSpritesDialEndpoint } from "./dispatch-env";
import { openSpritesProxyTunnel } from "../runner/sprites-tunnel";
import { getRunnerProvider } from "../runner/provider";

export type { WorkerEventHandler };

/** WebSocket ping cadence. A test seam shrinks it so the missed-pong liveness
 * check (two intervals) fires in milliseconds instead of tens of seconds. */
let heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
export function __setHeartbeatIntervalForTests(ms: number): void {
  heartbeatIntervalMs = ms;
}
export function __resetHeartbeatIntervalForTests(): void {
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS;
}

export interface ControllerConnectionOptions {
  runId: number;
  instanceId: string;
  endpoint: string;
  controllerId: string;
  onEvent?: WorkerEventHandler;
  /** Fired when the socket closes without an intentional {@link disconnect}. The
   * registry uses it to drive the bounded reconnect grace. */
  onClose?: (info: { code: number }) => void;
  /** Fired once, after the authoritative run.commit for a terminal outcome has
   * been delivered, so the registry can stop the provider and clear the claim. */
  onTerminal?: (info: { status: string }) => void;
  /** Dependency injection for socket-level tests. */
  createSocket?: (endpoint: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  /** Injection for the Sprites proxy tunnel. Default is {@link openSpritesProxyTunnel}. */
  openTunnel?: (target: { spriteName: string; port: number }) => Promise<Duplex>;
  /** A per-run blob coordinator that outlives individual connections so a
   * reconnect resumes the same durable receiver instead of racing a second one
   * over the shared on-disk blob store. */
  blobs?: BlobCoordinator;
}

/** Worker events that carry a terminal outcome. Their run.commit reply is the
 * signal for the registry to tear the channel down. */
const TERMINAL_EVENT_STATUS: Record<string, string> = {
  "run.finished": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
};
const TERMINAL_EVENT_TYPES = new Set(Object.keys(TERMINAL_EVENT_STATUS));

/** WebSocket close reasons are capped at 123 UTF-8 bytes. */
function safeCloseReason(reason: string): string {
  return Buffer.byteLength(reason, "utf8") <= 123 ? reason : reason.slice(0, 100);
}

/**
 * Split a stored dial endpoint into the URL to dial and any extra request
 * headers it implies. Every current endpoint (ws+unix://…, ws://[ip]:8787/…)
 * passes through unchanged with no extra headers; the seam exists so a future
 * proxied provider can attach per-endpoint auth without touching the dialer.
 * Sprites `sprite://` endpoints are handled separately via the proxy tunnel
 * (see `createSpritesProxiedSocket`) — this helper leaves them untouched for
 * callers that only need to inspect the raw endpoint.
 */
export function resolveDialTarget(endpoint: string): { url: string; headers: Record<string, string> } {
  return { url: endpoint, headers: {} };
}



function raw(data: RawData): string | ArrayBuffer | Uint8Array {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

function once(ws: WebSocket, event: "open" | "message"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const failure = (error: Error) => { cleanup(); reject(error); };
    const success = (value: unknown) => { cleanup(); resolve(value); };
    const cleanup = () => { ws.off(event, success); ws.off("error", failure); };
    ws.once(event, success); ws.once("error", failure);
  });
}

/** One fenced control-plane connection.  The registry owns retries. */
export class ControllerConnection {
  readonly runId: number;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly controllerId: string;
  private readonly onEvent: WorkerEventHandler;
  private readonly onClose?: (info: { code: number }) => void;
  private readonly onTerminal?: (info: { status: string }) => void;
  private readonly createSocket: NonNullable<ControllerConnectionOptions["createSocket"]>;
  private readonly openTunnel: NonNullable<ControllerConnectionOptions["openTunnel"]>;
  private socket?: WebSocket;
  private epoch = 0;
  private stopped = false;
  private pingTimer?: NodeJS.Timeout;
  /** Consecutive ping ticks with no intervening pong; reset by the pong handler. */
  private missedPongs = 0;
  /** In-flight {@link connect} attempt so concurrent dials share one handshake. */
  private connecting?: Promise<void>;
  private serial: Promise<void> = Promise.resolve();
  private ackWaiters = new Map<number, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
  private readonly blobs: BlobCoordinator;

  constructor(options: ControllerConnectionOptions) {
    this.runId = options.runId;
    this.instanceId = options.instanceId;
    this.endpoint = options.endpoint;
    this.controllerId = options.controllerId;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onClose = options.onClose;
    this.onTerminal = options.onTerminal;
    this.createSocket = options.createSocket ?? ((url, protocols, socketOptions) => new WebSocket(url, protocols, socketOptions));
    this.openTunnel = options.openTunnel ?? ((target) => openSpritesProxyTunnel(target));
    // Blob store is anchored per run+instance so a fresh connection after a
    // reconnect resumes a partial transfer from the durable receiver cursor. The
    // coordinator is normally supplied by the registry and shared across
    // reconnects; a standalone connection creates its own.
    const blobRoot = join(tmpdir(), "task-orchestrator", "channel-blobs", `${this.runId}-${this.instanceId}`);
    this.blobs = options.blobs ?? new BlobCoordinator(blobRoot, this.controlBlobIO());
  }

  /** The per-run blob coordinator; the registry keeps it across reconnects. */
  get blobCoordinator(): BlobCoordinator {
    return this.blobs;
  }

  /** Send an attachment blob to the worker (e.g. a run.start attachment) to
   * completion before the referencing command is delivered. */
  sendBlob(ref: Omit<BlobRef, "type">, data: Buffer): Promise<void> {
    return this.blobs.sendBlob(ref, data);
  }

  /** Path a fully received worker→control blob was renamed to. */
  blobPath(blobId: string): string {
    return this.blobs.pathFor(blobId);
  }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  /** The last accepted hello. A worker process that has never acked a command
   * (`lastAckedControlSeq === 0`) is a fresh generation that still needs its
   * run.start, whatever the caller believes about it. */
  get workerNeverAcked(): boolean { return this.lastHello?.lastAckedControlSeq === 0; }
  /** Whether the worker process holds a run.start, as reported in its hello.
   *  `undefined` for bundles that predate the field. */
  get workerHasStart(): boolean | undefined { return this.lastHello?.started; }
  private lastHello?: ChannelHello;
  /** True once disconnect()/abandon()/neutralize() ran: connect() refuses forever. */
  get shutDown(): boolean { return this.stopped; }
  get controllerEpoch(): number { return this.epoch; }

  async connect(options: { bumpEpoch?: boolean } = {}): Promise<void> {
    if (this.stopped) throw new Error("controller connection is shut down");
    // Re-entrancy guard: a reconnect backoff timer (attemptReconnect) and
    // connectRun can all dial this same object concurrently.
    // Without a guard, whichever handshake resolves LAST overwrites this.socket /
    // this.epoch — possibly with the losing socket — and orphans the live one.
    // Subsequent callers await and share the one in-flight attempt.
    if (this.connecting) return this.connecting;
    this.connecting = this.connectInner(options).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connectInner(options: { bumpEpoch?: boolean }): Promise<void> {
    const lease = await acquireControllerLease(this.runId, this.controllerId, new Date(), { bump: options.bumpEpoch });
    this.epoch = lease.epoch;
    const credential = mintChannelCredential(this.runId, this.instanceId);
    let socket: WebSocket;
    if (isSpritesDialEndpoint(this.endpoint)) {
      socket = await this.createSpritesProxiedSocket(credential);
    } else {
      const { url: dialUrl, headers: proxyHeaders } = resolveDialTarget(this.endpoint);
      socket = this.createSocket(dialUrl, [WORKER_CHANNEL_SUBPROTOCOL], {
        headers: { Authorization: `Bearer ${credential}`, ...proxyHeaders },
        handshakeTimeout: 10_000,
      });
    }
    this.socket = socket;
    // The worker speaks first. Its `channel.hello` is frequently coalesced into
    // the same TCP segment as the 101 handshake, so `ws` emits 'open' and then
    // 'message' in the same tick. Capture the first frame synchronously, before
    // awaiting 'open', or the hello is dropped and connect() hangs forever.
    const firstFrame = this.captureFirstFrame(socket);
    firstFrame.catch(() => undefined);
    try {
      await once(socket, "open");
      const hello = this.readHello(await firstFrame);
      this.lastHello = hello;
      if (hello.protocol.min > WORKER_CHANNEL_PROTOCOL || hello.protocol.max < WORKER_CHANNEL_PROTOCOL) {
        socket.close(CLOSE_CODE_PROTOCOL_MISMATCH, "protocol mismatch");
        throw new ControllerProtocolError("worker does not support protocol v1", CLOSE_CODE_PROTOCOL_MISMATCH, false);
      }
      // Attach the persistent listeners BEFORE sending accept and the post-accept
      // DB awaits below. The worker replays its spooled events the instant it sees
      // channel.accept; a listener attached only after markChannelConnected /
      // rebasePendingCommands / blobs.rebind would let `ws` emit those replayed
      // frames to no listener — silently dropping them until a later reconnect.
      // captureFirstFrame already consumed the hello with a one-shot listener, and
      // the worker sends nothing between hello and our accept, so this persistent
      // listener never double-processes a frame.
      this.attachSocketHandlers(socket);
      const lastAcceptedWorkerSeq = await getLastAcceptedWorkerSeq(this.runId, this.instanceId);
      // channel.accept is a handshake frame ({v,type,seq,payload}), not an
      // envelope: the codec validates it strictly, so it must not carry the
      // id/runId/instanceId/sentAt envelope fields.
      this.send({
        v: WORKER_CHANNEL_PROTOCOL,
        type: "channel.accept",
        seq: 0,
        payload: {
          protocol: WORKER_CHANNEL_PROTOCOL,
          controllerEpoch: lease.epoch,
          leaseId: lease.leaseId,
          lastAcceptedWorkerSeq,
          heartbeatMs: DEFAULT_HEARTBEAT_MS,
          disconnectGraceMs: DEFAULT_DISCONNECT_GRACE_MS,
          maxInFlightBytes: DEFAULT_MAX_IN_FLIGHT_BYTES,
        },
      } as WireFrame);
      // Record the worker's incarnation off the handshake path: it awaits the
      // provider API (two round trips, 30s timeouts) while the worker's accept
      // timer is 10s. Liveness treats a missing incarnation as "trust the
      // observation", so a late or failed record is never a wrong verdict.
      void this.observeHelloIncarnation(hello);
      await markChannelConnected(this.runId, this.instanceId, new Date());
      await rebasePendingCommands(this.runId, this.instanceId, lease.epoch);
      for (const command of await listPendingCommands(this.runId, this.instanceId, lease.epoch)) this.sendCommandRow(command);
      // Bind the shared coordinator to THIS connection's transport and re-announce
      // any outgoing blob so a reconnect resumes from the receiver's cursor.
      await this.blobs.rebind(this.controlBlobIO());
      this.startPings();
      // Recover tool invocations stranded by a control-plane crash after their
      // receipt committed and was acked but before a tool.result persisted (BUG
      // 1b). The worker will not replay an already-acked invocation, so this sweep
      // is the only thing that unhangs the agent's call. Fire-and-forget so it
      // never blocks the receive loop; it is idempotent and guarded against
      // double-running a concurrently live redelivery.
      void sweepOrphanedToolInvokes(this.runId, this.instanceId, this.toolIO()).catch(() => undefined);
    } catch (error) {
      if (this.socket === socket) this.socket = undefined;
      socket.terminate();
      await releaseControllerLease(this.runId, this.controllerId, lease.epoch).catch(() => undefined);
      throw error;
    }
  }

  /** Sprites proxy → inner WebSocket tunnel. The control plane holds
   * SPRITES_TOKEN, the worker dials `sprite://<name>:8787`. The proxy handshake
   * (`WSS /sprites/{name}/proxy` + JSON {host,port}) is performed first, then
   * the inner channel WS is upgraded over that TCP relay (WS-over-WS). */
  private async createSpritesProxiedSocket(credential: string): Promise<WebSocket> {
    const parsed = parseSpritesDialEndpoint(this.endpoint);
    if (!parsed) {
      throw new ControllerProtocolError(`malformed sprites endpoint: ${this.endpoint}`, CLOSE_CODE_SCOPE_MISMATCH, false);
    }
    if (!config.sprites.token) {
      throw new ControllerProtocolError("SPRITES_TOKEN is required to dial sprite:// endpoints", CLOSE_CODE_SCOPE_MISMATCH, false);
    }
    const tunnel = await this.openTunnel(parsed);
    const innerUrl = `ws://localhost:${parsed.port}/worker/channel`;
    return this.createSocket(innerUrl, [WORKER_CHANNEL_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${credential}` },
      handshakeTimeout: 10_000,
      createConnection: () => tunnel as unknown as import("node:net").Socket,
    } as unknown as WebSocket.ClientOptions);
  }

  /** Attach the persistent message/pong/close/error listeners for one socket.
   * Called during the handshake, before the post-accept awaits, so no replayed
   * worker frame is dropped (see {@link connectInner}). */
  private attachSocketHandlers(socket: WebSocket): void {
    socket.on("message", (data, isBinary) =>
      this.enqueue(() => (isBinary ? this.receiveBinary(data) : this.receive(raw(data)))),
    );
    socket.on("pong", () => {
      // A pong proves the peer is live: reset the missed-pong liveness counter.
      this.missedPongs = 0;
      this.enqueue(() => this.touch());
    });
    socket.on("close", (code: number) => {
      this.stopPings();
      // An intentional disconnect() flips `stopped` first; anything else is an
      // unexpected drop the registry may reconnect within the grace window.
      if (!this.stopped && this.socket === socket) {
        this.socket = undefined;
        this.onClose?.({ code });
      }
    });
    socket.on("error", () => undefined);
  }

  async sendPersisted(command: CommandRow): Promise<void> {
    if (command.controllerEpoch !== this.epoch) return;
    if (this.connected) this.sendCommandRow(command);
  }

  waitForAck(seq: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const current = this.ackWaiters.get(seq) ?? [];
      current.push({ resolve, reject });
      this.ackWaiters.set(seq, current);
    });
  }

  /** Stand the connection down WITHOUT force-closing the socket: stop pings and
   * flip `stopped` so an unexpected-close handler will not reconnect. Used for
   * terminal teardown, where the worker closes its own side cleanly after it
   * receives the authoritative run.commit — closing first here would race that
   * commit off the wire. */
  neutralize(): void {
    this.stopped = true;
    this.stopPings();
  }

  async disconnect(release = true): Promise<void> {
    this.stopped = true;
    this.stopPings();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "controller shutdown");
    // Ack waiters RESOLVE on an intentional disconnect: the command is a durable
    // row, so the next process (hot deploy) or reconnect replays it — consistent
    // with sendCommand's not-connected early return, which also reports success
    // on the strength of the durable row.
    for (const waiters of this.ackWaiters.values()) for (const waiter of waiters) waiter.resolve();
    this.ackWaiters.clear();
    if (release && this.epoch) await releaseControllerLease(this.runId, this.controllerId, this.epoch);
  }

  /** Abandon the connection when the reconnect grace is exhausted. Unlike
   * {@link disconnect}, this REJECTS in-flight ack waiters: no reconnect will
   * replay their commands from here (the run is being handed to the reaper), so a
   * sendCommand awaiting confirmation must observe a failure rather than a silent
   * false success for a command this channel never delivered. */
  async abandon(): Promise<void> {
    this.stopped = true;
    this.stopPings();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "controller abandoned");
    const error = new ControllerAbandonedError(
      `worker channel for run ${this.runId} was abandoned after the reconnect grace expired`,
    );
    for (const waiters of this.ackWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.ackWaiters.clear();
  }

  /** Attach the message listener immediately so no worker-first frame is lost
   * between 'open' and the point we start reading. */
  private captureFirstFrame(socket: WebSocket): Promise<RawData> {
    return new Promise<RawData>((resolve, reject) => {
      const onMessage = (data: RawData) => { cleanup(); resolve(data); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new ControllerProtocolError("worker closed before hello", CLOSE_CODE_SCOPE_MISMATCH, true)); };
      const cleanup = () => { socket.off("message", onMessage); socket.off("error", onError); socket.off("close", onClose); };
      socket.once("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  private readHello(data: RawData): ChannelHello {
    const frame = decodeFrame(raw(data));
    if (frame.type !== "channel.hello") throw new ControllerProtocolError("worker did not send channel.hello", CLOSE_CODE_SCOPE_MISMATCH, false);
    return frame.payload as ChannelHello;
  }

  /**
   * The worker cannot inspect its Sprite (it has no provider token). The
   * provider-derived value is therefore authoritative: for the same process,
   * provider.inspect().incarnation === stored incarnation.
   */
  private async observeHelloIncarnation(hello: ChannelHello): Promise<void> {
    try {
      const target = await getWorkerObservationTarget(this.runId, this.instanceId);
      if (!target) return;
      const provider = getRunnerProvider();
      if (provider.kind !== target.provider) {
        console.warn(`[worker-channel] liveness observation provider mismatch runId=${this.runId} row=${target.provider} configured=${provider.kind}`);
        return;
      }
      const observed = await provider.inspect(target.handle);
      if (observed.status !== "alive") return;
      // The handle we inspected is the instance registered for this channel, so
      // the observed process IS the one we dialed: the handle suffices. The pid
      // is NOT a cross-check — a sprite service reports its wrapper's pid
      // (2768) while the node worker sees its own (2379), and Docker has no
      // comparable pid at all. Vetoing on that mismatch froze run 187's stored
      // incarnation at its first worker, so every later liveness check said
      // dead(replaced) and the reapers cleared live claims (2026-08-27).
      if (observed.pid != null && hello.pid != null && observed.pid !== hello.pid) {
        console.log(`[worker-channel] hello pid ${hello.pid} differs from provider pid ${observed.pid} for run ${this.runId}; trusting the handle`);
      }
      await persistWorkerIncarnation(this.runId, this.instanceId, observed.incarnation);
    } catch (err) {
      console.warn(`[worker-channel] liveness observation failed runId=${this.runId}:`, err);
    }
  }

  /** The transport seam handed to the tool-invoke handler. Reads `connected`
   *  and `epoch` live so a disconnect mid-execution is observed. */
  private toolIO(): ToolChannelIO {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get epoch() { return self.epoch; },
      get connected() { return self.connected; },
      send: (frame) => self.send(frame),
    };
  }

  private frame<T>(type: string, payload: T): WorkerEnvelope<T> {
    return { v: 1, type, id: randomUUID(), runId: this.runId, instanceId: this.instanceId, controllerEpoch: this.epoch, seq: 0, sentAt: new Date().toISOString(), payload };
  }

  private send(frame: WireFrame): void {
    if (!this.connected) return;
    this.socket!.send(encodeFrame(frame));
  }

  private sendCommandRow(row: CommandRow, replyTo?: string): void {
    const frame: WorkerCommand = {
      v: 1, type: row.type as WorkerCommand["type"], id: row.id, runId: row.runId,
      instanceId: row.instanceId, controllerEpoch: row.controllerEpoch, seq: row.seq,
      sentAt: row.createdAt.toISOString(), payload: row.payload as never,
      ...(replyTo ? { replyTo } : {}),
    } as WorkerCommand;
    this.send(frame);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.serial = this.serial.then(operation, operation).catch((error) => {
      const violation = error as { closeCode?: number };
      const code =
        typeof violation.closeCode === "number" ? violation.closeCode : CLOSE_CODE_SCOPE_MISMATCH;
      // A WebSocket close reason must fit in 123 UTF-8 bytes; an over-long blob
      // digest-mismatch message would otherwise make close() throw and leave the
      // socket stuck in CLOSING.
      const reason = safeCloseReason(error instanceof Error ? error.message : "worker channel failure");
      try {
        this.socket?.close(code, reason);
      } catch {
        this.socket?.terminate();
      }
    });
  }

  private async receive(data: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (this.stopped) return;
    const frame = decodeFrame(data);
    assertEnvelopeScope(frame, this.runId, this.instanceId);
    // Every inbound frame is worker-authored (events + transport acks); the
    // control plane never receives commands. A replayed worker event retains the
    // epoch it was first emitted under, and acquireControllerLease bumps the epoch
    // on any reconnect where the prior lease is not live — so a spooled event can
    // legitimately arrive stamped with an epoch BELOW the current one. Fencing is
    // only for commands sent *to* the worker (protocol: "Handshake and fencing");
    // here the instance-id scope check above and applyWorkerEvent's seq-based
    // dedupe guard correctness. Reject only an epoch AHEAD of ours — a worker can
    // never have seen a controller epoch we have not issued, so that is a genuine
    // protocol violation.
    if (frame.controllerEpoch > this.epoch) throw new ControllerProtocolError("worker epoch ahead of controller", CLOSE_CODE_STALE_CONTROLLER_EPOCH, false);
    await this.touch();
    if (isTransportFrame(frame)) {
      if (frame.type === "channel.ack") {
        const through = frame.payload.throughSeq;
        await ackCommandsThrough(this.runId, this.instanceId, this.epoch, through, new Date());
        for (const [seq, waiters] of [...this.ackWaiters]) if (seq <= through) {
          this.ackWaiters.delete(seq); for (const waiter of waiters) waiter.resolve();
        }
      }
      return;
    }
    if (!isWorkerEvent(frame)) throw new ControllerProtocolError("unexpected control-plane frame", CLOSE_CODE_SCOPE_MISMATCH, false);
    if (isBlobControlFrame(frame)) {
      await this.handleBlobEvent(frame);
      return;
    }
    // Ordering rule: a worker event that references a blob is a protocol
    // violation unless that blob has already completed on this side.
    this.assertBlobRefsComplete(frame.payload);
    if (frame.type === "tool.invoke") {
      // Reserve the receipt and ack the worker sequence IN ORDER (serial), then
      // float the possibly-long tool execution so it never blocks later frames.
      const outcome = await reserveToolInvoke(frame as ToolInvokeEnvelope, this.toolIO());
      if (outcome.duplicate) {
        if (outcome.replay) this.sendCommandRow(outcome.replay, frame.id);
        // A redelivered invocation whose receipt committed but whose result was
        // never produced (the control plane acked it, then crashed/threw before
        // persisting tool.result): re-execute so the agent's call is not stranded
        // (BUG 1a). The in-flight guard + persistToolResultCommand dedupe make a
        // double result/side effect impossible in-process.
        else if (outcome.reexecute) void executeToolInvoke(frame as ToolInvokeEnvelope, this.toolIO()).catch(() => undefined);
        return;
      }
      void executeToolInvoke(frame as ToolInvokeEnvelope, this.toolIO()).catch(() => undefined);
      return;
    }
    const result = await applyWorkerEvent(frame, this.onEvent);
    // A terminal worker event (run.finished/failed/cancelled) makes the handler
    // enqueue an authoritative `run.commit`. Deliver it to the worker replying to
    // this event's id so its `waitForCommit(finishEventId)` resolves — the worker
    // never lands the terminal status itself; this is the commit that confirms the
    // control plane did.
    if (result.resultCommandId) {
      const command = await getCommand(result.resultCommandId);
      if (command && command.controllerEpoch === this.epoch) this.sendCommandRow(command, frame.id);
      // run.finished/failed/cancelled land a terminal outcome and enqueue the
      // authoritative run.commit above. Once it is on the wire, the registry can
      // stop the provider and clear the controller lease / worker claim.
      if (TERMINAL_EVENT_TYPES.has(frame.type)) {
        const status = TERMINAL_EVENT_STATUS[frame.type];
        this.onTerminal?.({ status });
      }
    }
    this.send(this.frame("channel.ack", { throughSeq: result.lastAcceptedWorkerSeq }) as WireFrame);
  }

  /** Route one unsequenced binary blob chunk frame to the blob receiver. */
  private async receiveBinary(data: RawData): Promise<void> {
    if (this.stopped) return;
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    await this.blobs.onBinary(buffer);
  }

  /** Apply a sequenced blob-control worker event (receipt + ack) and route it to
   * the blob coordinator. Routing runs even for a duplicate so a replayed
   * `blob.open` after a reconnect re-emits its persisted resume cursor. */
  private async handleBlobEvent(frame: WorkerEvent): Promise<void> {
    const result = await applyWorkerEvent(frame, this.onEvent);
    if (frame.type === "blob.open") await this.blobs.onBlobOpen(frame.payload as BlobOpenMessage);
    else if (frame.type === "blob.accepted") await this.blobs.onBlobAccepted(frame.payload as BlobAcceptedMessage);
    else if (frame.type === "blob.rejected") this.blobs.onBlobRejected(frame.payload as BlobRejectedMessage);
    this.send(this.frame("channel.ack", { throughSeq: result.lastAcceptedWorkerSeq }) as WireFrame);
  }

  private assertBlobRefsComplete(payload: unknown): void {
    for (const ref of collectBlobRefs(payload)) {
      if (!this.blobs.isComplete(ref.blobId)) {
        throw new ControllerProtocolError(
          `worker referenced incomplete blob ${ref.blobId}`,
          CLOSE_CODE_SCOPE_MISMATCH,
          false,
        );
      }
    }
  }

  private controlBlobIO(): BlobWireIO {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async sendBlobOpen(message) {
        await self.enqueueCommand("blob.open", message);
      },
      async sendBlobAccepted(message) {
        await self.enqueueCommand("blob.accepted", message);
      },
      async sendBlobRejected(message) {
        await self.enqueueCommand("blob.rejected", message);
      },
      sendBinary(frame) {
        self.sendBinaryFrame(frame);
      },
    };
  }

  private async enqueueCommand(type: string, payload: unknown): Promise<void> {
    const row = await persistCommand({
      runId: this.runId,
      instanceId: this.instanceId,
      controllerEpoch: this.epoch,
      type,
      payload,
    });
    if (row.controllerEpoch === this.epoch && this.connected) this.sendCommandRow(row);
  }

  private sendBinaryFrame(frame: Buffer): void {
    if (!this.connected) return;
    this.socket!.send(frame, { binary: true });
  }

  private async touch(): Promise<void> {
    const ok = await touchChannel(this.runId, this.instanceId, this.controllerId, this.epoch, new Date());
    if (!ok) throw new ControllerProtocolError("controller lease lost", CLOSE_CODE_STALE_CONTROLLER_EPOCH, false);
  }

  private startPings(): void {
    this.stopPings();
    this.missedPongs = 0;
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      // Liveness: a half-open TCP socket keeps readyState OPEN indefinitely. With
      // an unconditional lease renewal the run would stall invisibly while the
      // lease stayed fresh and the reaper never fired. Count ping ticks with no
      // intervening pong (the 'pong' handler resets the counter); after two missed
      // intervals terminate the socket so its 'close' fires onClose and the
      // registry reconnect path takes over.
      if (this.missedPongs >= 2) {
        socket.terminate();
        return;
      }
      this.missedPongs += 1;
      socket.ping();
      // Re-check the epoch fence each tick: another controller taking the run
      // over is the only way this connection loses its lease.
      this.enqueue(() => this.touch());
    }, heartbeatIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPings(): void { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = undefined; }
}

export class ControllerProtocolError extends Error {
  constructor(message: string, readonly closeCode: number, readonly retryable: boolean) { super(message); this.name = "ControllerProtocolError"; }
}

/** Raised into in-flight sendCommand callers when a channel is abandoned after
 * the reconnect grace expires — the command was persisted but not delivered on
 * this channel, so success must not be reported. */
export class ControllerAbandonedError extends Error {
  constructor(message: string) { super(message); this.name = "ControllerAbandonedError"; }
}
