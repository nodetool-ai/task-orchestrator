import { randomUUID } from "node:crypto";
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
  getLastAcceptedWorkerSeq,
  listPendingCommands,
  markChannelConnected,
  persistCommand,
  rebasePendingCommands,
  releaseControllerLease,
  renewControllerLease,
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
import { executeToolInvoke, reserveToolInvoke, type ToolChannelIO } from "./tool-invoke";

export type { WorkerEventHandler };

export interface ControllerConnectionOptions {
  runId: number;
  instanceId: string;
  endpoint: string;
  controllerId: string;
  onEvent?: WorkerEventHandler;
  /** Dependency injection for socket-level tests. */
  createSocket?: (endpoint: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
  /** A per-run blob coordinator that outlives individual connections so a
   * reconnect resumes the same durable receiver instead of racing a second one
   * over the shared on-disk blob store. */
  blobs?: BlobCoordinator;
}

/** WebSocket close reasons are capped at 123 UTF-8 bytes. */
function safeCloseReason(reason: string): string {
  return Buffer.byteLength(reason, "utf8") <= 123 ? reason : reason.slice(0, 100);
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
  private readonly createSocket: NonNullable<ControllerConnectionOptions["createSocket"]>;
  private socket?: WebSocket;
  private epoch = 0;
  private stopped = false;
  private pingTimer?: NodeJS.Timeout;
  private serial: Promise<void> = Promise.resolve();
  private ackWaiters = new Map<number, Array<() => void>>();
  private readonly blobs: BlobCoordinator;

  constructor(options: ControllerConnectionOptions) {
    this.runId = options.runId;
    this.instanceId = options.instanceId;
    this.endpoint = options.endpoint;
    this.controllerId = options.controllerId;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.createSocket = options.createSocket ?? ((url, protocols, socketOptions) => new WebSocket(url, protocols, socketOptions));
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
  get controllerEpoch(): number { return this.epoch; }

  async connect(): Promise<void> {
    if (this.stopped) throw new Error("controller connection is shut down");
    const lease = await acquireControllerLease(this.runId, this.controllerId, new Date());
    this.epoch = lease.epoch;
    const credential = mintChannelCredential(this.runId, this.instanceId);
    const socket = this.createSocket(this.endpoint, [WORKER_CHANNEL_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${credential}` },
      handshakeTimeout: 10_000,
    });
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
      if (hello.protocol.min > WORKER_CHANNEL_PROTOCOL || hello.protocol.max < WORKER_CHANNEL_PROTOCOL) {
        socket.close(CLOSE_CODE_PROTOCOL_MISMATCH, "protocol mismatch");
        throw new ControllerProtocolError("worker does not support protocol v1", CLOSE_CODE_PROTOCOL_MISMATCH, false);
      }
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
      await markChannelConnected(this.runId, this.instanceId, new Date());
      await rebasePendingCommands(this.runId, this.instanceId, lease.epoch);
      for (const command of await listPendingCommands(this.runId, this.instanceId, lease.epoch)) this.sendCommandRow(command);
      // Bind the shared coordinator to THIS connection's transport and re-announce
      // any outgoing blob so a reconnect resumes from the receiver's cursor.
      await this.blobs.rebind(this.controlBlobIO());
      socket.on("message", (data, isBinary) =>
        this.enqueue(() => (isBinary ? this.receiveBinary(data) : this.receive(raw(data)))),
      );
      socket.on("pong", () => this.enqueue(() => this.touch()));
      socket.on("close", () => this.stopPings());
      socket.on("error", () => undefined);
      this.startPings();
    } catch (error) {
      if (this.socket === socket) this.socket = undefined;
      socket.terminate();
      await releaseControllerLease(this.runId, this.controllerId, lease.epoch).catch(() => undefined);
      throw error;
    }
  }

  async sendPersisted(command: CommandRow): Promise<void> {
    if (command.controllerEpoch !== this.epoch) return;
    if (this.connected) this.sendCommandRow(command);
  }

  waitForAck(seq: number): Promise<void> {
    return new Promise((resolve) => {
      const current = this.ackWaiters.get(seq) ?? [];
      current.push(resolve);
      this.ackWaiters.set(seq, current);
    });
  }

  async disconnect(release = true): Promise<void> {
    this.stopped = true;
    this.stopPings();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "controller shutdown");
    for (const waiters of this.ackWaiters.values()) for (const resolve of waiters) resolve();
    this.ackWaiters.clear();
    if (release && this.epoch) await releaseControllerLease(this.runId, this.controllerId, this.epoch);
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
    if (frame.controllerEpoch !== this.epoch) throw new ControllerProtocolError("stale worker epoch", CLOSE_CODE_STALE_CONTROLLER_EPOCH, false);
    await this.touch();
    if (isTransportFrame(frame)) {
      if (frame.type === "channel.ack") {
        const through = frame.payload.throughSeq;
        await ackCommandsThrough(this.runId, this.instanceId, this.epoch, through, new Date());
        for (const [seq, waiters] of [...this.ackWaiters]) if (seq <= through) {
          this.ackWaiters.delete(seq); for (const resolve of waiters) resolve();
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
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.socket!.ping();
      this.enqueue(async () => {
        const ok = await renewControllerLease(this.runId, this.controllerId, this.epoch, new Date());
        if (!ok) throw new ControllerProtocolError("controller lease lost", CLOSE_CODE_STALE_CONTROLLER_EPOCH, false);
      });
    }, DEFAULT_HEARTBEAT_MS);
    this.pingTimer.unref?.();
  }

  private stopPings(): void { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = undefined; }
}

export class ControllerProtocolError extends Error {
  constructor(message: string, readonly closeCode: number, readonly retryable: boolean) { super(message); this.name = "ControllerProtocolError"; }
}
