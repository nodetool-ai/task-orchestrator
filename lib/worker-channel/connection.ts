import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { assertEnvelopeScope, decodeFrame, encodeFrame, isTransportFrame, isWorkerEvent } from "./codec";
import { mintChannelCredential } from "./credential";
import {
  ackCommandsThrough,
  acquireControllerLease,
  applyWorkerEvent,
  getLastAcceptedWorkerSeq,
  listPendingCommands,
  markChannelConnected,
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
  type ChannelHello,
  type WorkerCommand,
  type WorkerEnvelope,
  type WorkerEvent,
  type WireFrame,
} from "./protocol";

export type { WorkerEventHandler };

export interface ControllerConnectionOptions {
  runId: number;
  instanceId: string;
  endpoint: string;
  controllerId: string;
  onEvent?: WorkerEventHandler;
  /** Dependency injection for socket-level tests. */
  createSocket?: (endpoint: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket;
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

  constructor(options: ControllerConnectionOptions) {
    this.runId = options.runId;
    this.instanceId = options.instanceId;
    this.endpoint = options.endpoint;
    this.controllerId = options.controllerId;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.createSocket = options.createSocket ?? ((url, protocols, socketOptions) => new WebSocket(url, protocols, socketOptions));
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
      socket.on("message", (data) => this.enqueue(() => this.receive(raw(data))));
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

  private frame<T>(type: string, payload: T): WorkerEnvelope<T> {
    return { v: 1, type, id: randomUUID(), runId: this.runId, instanceId: this.instanceId, controllerEpoch: this.epoch, seq: 0, sentAt: new Date().toISOString(), payload };
  }

  private send(frame: WireFrame): void {
    if (!this.connected) return;
    this.socket!.send(encodeFrame(frame));
  }

  private sendCommandRow(row: CommandRow): void {
    const frame: WorkerCommand = {
      v: 1, type: row.type as WorkerCommand["type"], id: row.id, runId: row.runId,
      instanceId: row.instanceId, controllerEpoch: row.controllerEpoch, seq: row.seq,
      sentAt: row.createdAt.toISOString(), payload: row.payload as never,
    } as WorkerCommand;
    this.send(frame);
  }

  private enqueue(operation: () => Promise<void>): void {
    this.serial = this.serial.then(operation, operation).catch((error) => {
      const code = error instanceof ControllerProtocolError ? error.closeCode : CLOSE_CODE_SCOPE_MISMATCH;
      this.socket?.close(code, error instanceof Error ? error.message : "worker channel failure");
    });
  }

  private async receive(data: string | ArrayBuffer | Uint8Array): Promise<void> {
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
    const result = await applyWorkerEvent(frame, this.onEvent);
    this.send(this.frame("channel.ack", { throughSeq: result.lastAcceptedWorkerSeq }) as WireFrame);
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
