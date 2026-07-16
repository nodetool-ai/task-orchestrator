import { randomUUID } from "node:crypto";
import {
  assertEnvelopeScope,
  assertPostHandshakeEnvelope,
  isTransportFrame,
  isWorkerCommand,
  isWorkerEvent,
} from "./codec";
import {
  CLOSE_CODE_CLEAN_DRAIN,
  CLOSE_CODE_SCOPE_MISMATCH,
  CLOSE_CODE_STALE_CONTROLLER_EPOCH,
  DEFAULT_DISCONNECT_GRACE_MS,
  type ChannelAck,
  type ChannelNack,
  type RunCancel,
  type RunCommit,
  type RunInput,
  type RunPark,
  type RunStart,
  type ToolCallResult,
  type ToolResult,
  type TransportFrame,
  type WorkerCommand,
  type WorkerEnvelope,
  type WorkerEvent,
  type WireFrame,
} from "./protocol";
import { WorkerOutbox } from "./spool";

/** The command payloads intentionally exposed to the run driver. */
export type WorkerSessionCommand = RunInput | RunCancel | RunPark | RunCommit | ToolResult;

/**
 * Small transport seam used by the worker supervisor.  Keeping this structural
 * lets the session work with ws, a test double, or a socket-backed adapter.
 */
export interface WorkerSessionTransport {
  send(frame: WireFrame): Promise<void> | void;
  close?(code?: number, reason?: string): Promise<void> | void;
}

export interface WorkerSessionAttachOptions {
  controllerEpoch: number;
  /** Last worker event sequence durably accepted by the controller. */
  lastAcceptedWorkerSeq?: number;
  /** Controller-negotiated in-flight budget applied to the durable outbox. */
  maxInFlightBytes?: number;
  transport: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void);
}

/** Handshake numbers the supervisor advertises in `channel.hello`. */
export interface WorkerHandshakeState {
  lastControllerEpoch: number;
  lastAckedControlSeq: number;
  nextWorkerSeq: number;
}

export interface WorkerSessionOptions {
  runId: number;
  instanceId: string;
  outbox: WorkerOutbox;
  transport?: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void);
  disconnectGraceMs?: number;
  /** Useful when a supervisor restores the last fenced epoch from disk. */
  controllerEpoch?: number;
}

export class WorkerSessionProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1002) {
    super(message);
    this.name = "WorkerSessionProtocolError";
    this.closeCode = closeCode;
  }
}

interface ActiveTransport {
  transport: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void);
  epoch: number;
}

interface ToolWaiter {
  callId: string;
  invocationId?: string;
  resolve(result: ToolCallResult): void;
  reject(error: unknown): void;
}

interface CommitWaiter {
  resolve(commit: RunCommit): void;
  reject(error: unknown): void;
}

/** A compact async queue with deterministic close semantics. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
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
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) {
          return Promise.resolve({ value: this.values.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stable((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/** Command identity excludes delivery metadata, which changes on rebase. */
function commandFingerprint(frame: WorkerCommand): string {
  return JSON.stringify(stable({ type: frame.type, payload: frame.payload, replyTo: frame.replyTo }));
}

function asTransport(
  transport: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void),
): WorkerSessionTransport {
  return typeof transport === "function" ? { send: transport } : transport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    return String(value);
  }
}

function normalizeToolResult(payload: ToolResult): ToolCallResult {
  const value = payload.result;
  if (isRecord(value) && Array.isArray(value.content)) {
    return {
      content: value.content as ToolCallResult["content"],
      isError: payload.isError ?? (typeof value.isError === "boolean" ? value.isError : undefined),
    };
  }
  return {
    content: [{ type: "text", text: stringifyResult(value) }],
    isError: payload.isError,
  };
}

/**
 * Worker-side actor seam for the control-plane channel.
 *
 * The session owns command ordering and idempotency, while WorkerOutbox owns
 * durable event sequencing.  A detached session remains alive during the
 * reconnect grace window; events continue to append to the outbox and replay
 * from the controller's negotiated cursor on the next attach.
 */
export class WorkerSession {
  readonly abortController = new AbortController();
  readonly abortSignal = this.abortController.signal;

  private readonly runId: number;
  private readonly instanceId: string;
  private readonly outbox: WorkerOutbox;
  private readonly disconnectGraceMs: number;
  private readonly commandsQueue = new AsyncQueue<WorkerSessionCommand>();
  private readonly startWaiters: Array<{
    resolve(start: RunStart): void;
    reject(error: unknown): void;
  }> = [];
  private readonly commitWaiters = new Map<string, CommitWaiter[]>();
  private readonly completedCommits = new Map<string, RunCommit>();
  private readonly toolWaiters = new Map<string, ToolWaiter>();
  private readonly commandIds = new Map<string, string>();
  private readonly sequenceFingerprints = new Map<number, Map<number, string>>();
  private active?: ActiveTransport;
  private disconnectTimer?: NodeJS.Timeout;
  private controllerEpoch: number;
  private lastCommandSeq = 0;
  private start?: RunStart;
  private startId?: string;
  private commandTail: Promise<void> = Promise.resolve();
  private eventTail: Promise<unknown> = Promise.resolve();
  private sendTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: WorkerSessionOptions) {
    this.runId = positiveInteger(options.runId, "runId");
    if (!/^wi_[a-f0-9]{32}$/.test(options.instanceId)) throw new TypeError("instanceId is invalid");
    this.instanceId = options.instanceId;
    this.outbox = options.outbox;
    this.disconnectGraceMs = positiveInteger(
      options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS,
      "disconnectGraceMs",
    );
    this.controllerEpoch = nonNegativeInteger(options.controllerEpoch ?? 0, "controllerEpoch");
    if (options.transport) {
      // Constructor transport is intentionally detached until an epoch is
      // supplied.  It is useful for callers that immediately call attach().
      this.pendingTransport = options.transport;
    }
  }

  private pendingTransport?: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void);

  /** Open the durable spool and create a session in one operation. This is the
   * single production `WorkerOutbox.open` call site (see plan section 9). */
  static async open(
    options: Omit<WorkerSessionOptions, "outbox"> & { root: string; maxInFlightBytes?: number },
  ): Promise<WorkerSession> {
    const outbox = await WorkerOutbox.open(options.root, options.runId, options.instanceId, {
      maxInFlightBytes: options.maxInFlightBytes,
    });
    return new WorkerSession({ ...options, outbox });
  }

  /** Snapshot the numbers the supervisor advertises in `channel.hello`. */
  handshakeState(): WorkerHandshakeState {
    return {
      lastControllerEpoch: this.controllerEpoch,
      lastAckedControlSeq: this.lastCommandSeq,
      nextWorkerSeq: this.outbox.nextSeq(),
    };
  }

  async waitForStart(): Promise<RunStart> {
    if (this.start) return this.start;
    if (this.closed) throw new Error("worker session is closed");
    return new Promise<RunStart>((resolve, reject) => this.startWaiters.push({ resolve, reject }));
  }

  commands(): AsyncIterable<WorkerSessionCommand> {
    return this.commandsQueue;
  }

  /** Attach a controller and replay events after its durable cursor. */
  async attach(
    transportOrOptions:
      | WorkerSessionAttachOptions
      | WorkerSessionTransport
      | ((frame: WireFrame) => Promise<void> | void),
    controllerEpoch?: number,
    lastAcceptedWorkerSeq = 0,
  ): Promise<void> {
    const options: WorkerSessionAttachOptions =
      typeof transportOrOptions === "object" && "transport" in transportOrOptions
        ? transportOrOptions
        : {
            transport: transportOrOptions,
            controllerEpoch: controllerEpoch ?? this.controllerEpoch,
            lastAcceptedWorkerSeq,
          };
    const epoch = positiveInteger(options.controllerEpoch, "controllerEpoch");
    const cursor = nonNegativeInteger(options.lastAcceptedWorkerSeq ?? 0, "lastAcceptedWorkerSeq");
    if (this.closed) throw new Error("worker session is closed");

    // Epoch fencing only. Closing the losing socket is a transport duty owned
    // by the supervisor (plan section 9); the session just stops routing to it.
    if (this.active) {
      if (epoch <= this.active.epoch) throw this.staleEpoch(epoch);
      this.active = undefined;
    } else if (epoch < this.controllerEpoch) {
      throw this.staleEpoch(epoch);
    }

    if (epoch > this.controllerEpoch) {
      this.controllerEpoch = epoch;
      this.lastCommandSeq = 0;
      this.sequenceFingerprints.clear();
    }
    if (options.maxInFlightBytes !== undefined) {
      this.outbox.setMaxInFlightBytes(options.maxInFlightBytes);
    }
    this.active = { transport: options.transport, epoch };
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
    }

    const active = this.active;
    try {
      await this.queueSend(async () => {
        if (this.active !== active) return;
        const replay = await this.outbox.listAfter(cursor);
        for (const frame of replay) {
          if (this.active !== active) return;
          await this.send(active.transport, frame as unknown as WireFrame);
        }
      });
    } catch (error) {
      if (this.active === active) this.detachTransport(active.transport);
      throw error;
    }
  }

  /** Reconnect is an explicit alias that also permits a same-epoch reconnect. */
  reconnect(
    transportOrOptions:
      | WorkerSessionAttachOptions
      | WorkerSessionTransport
      | ((frame: WireFrame) => Promise<void> | void),
    controllerEpoch?: number,
    lastAcceptedWorkerSeq = 0,
  ): Promise<void> {
    return this.attach(transportOrOptions, controllerEpoch, lastAcceptedWorkerSeq);
  }

  /** Detach without aborting; the grace timer keeps the run resumable. */
  async detach(reason = "controller disconnected"): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.detachTransport(active.transport);
    if (!this.closed) {
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = undefined;
        this.abort(`worker controller disconnect grace expired: ${reason}`);
        void this.close();
      }, this.disconnectGraceMs);
    }
  }

  /** Compatibility hook used by worker-server. */
  onDisconnect(): Promise<void> {
    return this.detach();
  }

  /** Compatibility hook used by worker-server after a new socket is active. */
  onReconnect(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
    }
  }

  /** Abort model work without destroying the durable session state. */
  abort(reason = "worker session aborted"): void {
    if (!this.abortSignal.aborted) this.abortController.abort(reason);
  }

  /** Receive either a command or a transport acknowledgement from a controller. */
  receive(frame: WireFrame): Promise<void> {
    if (isTransportFrame(frame)) return this.handleTransportFrame(frame);
    if (isWorkerCommand(frame)) return this.acceptCommand(frame);
    throw new WorkerSessionProtocolError("worker session received an invalid frame", 1002);
  }

  handleFrame(frame: WireFrame): Promise<void> {
    return this.receive(frame);
  }

  /** Hook consumed by worker-server. */
  acceptCommand(frame: WorkerCommand): Promise<void> {
    const operation = this.commandTail.then(() => this.acceptCommandInner(frame));
    this.commandTail = operation.catch(() => undefined);
    return operation;
  }

  /** Compatibility alias for older supervisor drafts. */
  pushCommand(frame: WorkerCommand): Promise<void> {
    return this.acceptCommand(frame);
  }

  async emit<T extends WorkerEvent["type"]>(
    type: T,
    payload: Extract<WorkerEvent, { type: T }>['payload'],
  ): Promise<WorkerEnvelope> {
    const operation = this.eventTail.then(async () => {
      if (this.closed) throw new Error("worker session is closed");
      if (!isWorkerEvent({ type } as WireFrame)) throw new Error(`Cannot emit non-worker event ${type}`);
      const frame = {
        v: 1 as const,
        type,
        id: randomUUID(),
        runId: this.runId,
        instanceId: this.instanceId,
        controllerEpoch: this.controllerEpoch,
        seq: this.outbox.nextSeq(),
        sentAt: new Date().toISOString(),
        payload,
      } as WorkerEvent;

      // This await is deliberately before looking up/sending on the socket.
      await this.outbox.append(frame);
      const active = this.active;
      if (active) await this.queueSend(() => this.send(active.transport, frame));
      return frame as WorkerEnvelope;
    });
    this.eventTail = operation.catch(() => undefined);
    return operation;
  }

  async invokeTool(tool: string, args: unknown, callId: string): Promise<ToolCallResult> {
    if (!tool || !callId) throw new TypeError("tool and callId are required");
    if (this.toolWaiters.has(callId)) throw new Error(`tool call ${callId} is already pending`);
    if (this.closed) throw new Error("worker session is closed");

    let waiter!: ToolWaiter;
    const result = new Promise<ToolCallResult>((resolve, reject) => {
      waiter = { callId, resolve, reject };
    });
    // The real handler is the `await result` below, but an abort can reject
    // `result` while this method is still awaiting `emit` — attach a swallowing
    // catch so that window never surfaces as an unhandled rejection.
    result.catch(() => undefined);
    this.toolWaiters.set(callId, waiter);
    // A run.cancel (or a disconnect-grace expiry) aborts the session; a tool call
    // in flight when that happens must reject so the model turn awaiting it
    // unwinds instead of hanging until the control plane eventually replies.
    const onAbort = () => waiter.reject(new Error("run cancelled before tool result"));
    if (this.abortSignal.aborted) {
      this.toolWaiters.delete(callId);
      throw new Error("run cancelled before tool result");
    }
    this.abortSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const invocation = await this.emit("tool.invoke", { tool, arguments: args, callId });
      waiter.invocationId = invocation.id;
      return await result;
    } catch (error) {
      this.toolWaiters.delete(callId);
      waiter.reject(error);
      throw error;
    } finally {
      this.abortSignal.removeEventListener("abort", onAbort);
      if (this.toolWaiters.get(callId) === waiter) this.toolWaiters.delete(callId);
    }
  }

  async waitForCommit(finishEventId: string): Promise<RunCommit> {
    if (!finishEventId) throw new TypeError("finishEventId is required");
    const completed = this.completedCommits.get(finishEventId);
    if (completed) return completed;
    if (this.closed) throw new Error("worker session is closed");
    return new Promise<RunCommit>((resolve, reject) => {
      const waiters = this.commitWaiters.get(finishEventId) ?? [];
      waiters.push({ resolve, reject });
      this.commitWaiters.set(finishEventId, waiters);
    });
  }

  /** Cleanly drain queued output, close the channel, and release spool files. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInner();
    return this.closePromise;
  }

  private async closeInner(): Promise<void> {
    this.closed = true;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = undefined;
    this.commandsQueue.close();
    this.abort("worker session closed");
    const error = new Error("worker session closed");
    for (const waiter of this.startWaiters.splice(0)) waiter.reject(error);
    for (const waiters of this.commitWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.commitWaiters.clear();
    for (const waiter of this.toolWaiters.values()) waiter.reject(error);
    this.toolWaiters.clear();

    const active = this.active;
    this.active = undefined;
    await this.eventTail.catch(() => undefined);
    await this.sendTail.catch(() => undefined);
    if (active) await this.closeTransport(active.transport, CLOSE_CODE_CLEAN_DRAIN, "worker session drained");
    await this.outbox.close();
  }

  private async acceptCommandInner(frame: WorkerCommand): Promise<void> {
    if (this.closed) throw new Error("worker session is closed");
    assertPostHandshakeEnvelope(frame);
    assertEnvelopeScope(frame, this.runId, this.instanceId);
    if (frame.controllerEpoch !== this.controllerEpoch) throw this.staleEpoch(frame.controllerEpoch);

    const fingerprint = commandFingerprint(frame);
    const priorId = this.commandIds.get(frame.id);
    if (priorId !== undefined && priorId !== fingerprint) {
      throw new WorkerSessionProtocolError(`command ${frame.id} was replayed with different contents`, CLOSE_CODE_SCOPE_MISMATCH);
    }

    const sequenceMap = this.sequenceFingerprintsFor(this.controllerEpoch);
    const priorSequence = sequenceMap.get(frame.seq);
    if (frame.seq <= this.lastCommandSeq) {
      if (priorSequence !== fingerprint && priorId === undefined) {
        throw new WorkerSessionProtocolError(`command sequence ${frame.seq} was replayed with different contents`, CLOSE_CODE_SCOPE_MISMATCH);
      }
      await this.sendCommandAck(this.lastCommandSeq);
      return;
    }
    if (frame.seq !== this.lastCommandSeq + 1) {
      await this.sendCommandNack(this.lastCommandSeq + 1);
      return;
    }

    const duplicate = priorId !== undefined;
    this.commandIds.set(frame.id, fingerprint);
    sequenceMap.set(frame.seq, fingerprint);
    this.lastCommandSeq = frame.seq;

    if (!duplicate) await this.deliverCommand(frame);
    await this.sendCommandAck(this.lastCommandSeq);
    if (frame.type === "channel.drain") await this.close();
  }

  private async deliverCommand(frame: WorkerCommand): Promise<void> {
    switch (frame.type) {
      case "run.start":
        if (!this.start) {
          this.start = frame.payload;
          this.startId = frame.id;
          for (const waiter of this.startWaiters.splice(0)) waiter.resolve(this.start);
        } else if (this.startId !== frame.id) {
          throw new WorkerSessionProtocolError("worker received a second run.start", CLOSE_CODE_SCOPE_MISMATCH);
        }
        return;
      case "run.input":
      case "run.cancel":
      case "run.park":
      case "run.commit":
      case "tool.result":
        if (frame.type === "run.cancel") this.abortController.abort(frame.payload.reason);
        if (frame.type === "tool.result") this.resolveTool(frame);
        if (frame.type === "run.commit") this.resolveCommit(frame);
        this.commandsQueue.push(frame.payload);
        return;
      case "channel.drain":
        return;
      case "tool.accepted":
      case "tool.progress":
        // These are valid protocol commands but are intentionally not exposed
        // through the narrow run-driver command iterator.
        return;
    }
  }

  private resolveTool(frame: Extract<WorkerCommand, { type: "tool.result" }>): void {
    const byReply = frame.replyTo
      ? [...this.toolWaiters.values()].find((waiter) => waiter.invocationId === frame.replyTo)
      : undefined;
    const waiter = byReply ?? this.toolWaiters.get(frame.payload.callId);
    if (waiter) waiter.resolve(normalizeToolResult(frame.payload));
  }

  private resolveCommit(frame: Extract<WorkerCommand, { type: "run.commit" }>): void {
    if (!frame.replyTo) return;
    this.completedCommits.set(frame.replyTo, frame.payload);
    const waiters = this.commitWaiters.get(frame.replyTo);
    if (!waiters) return;
    this.commitWaiters.delete(frame.replyTo);
    for (const waiter of waiters) waiter.resolve(frame.payload);
  }

  private sequenceFingerprintsFor(epoch: number): Map<number, string> {
    let map = this.sequenceFingerprints.get(epoch);
    if (!map) {
      map = new Map();
      this.sequenceFingerprints.set(epoch, map);
    }
    return map;
  }

  private async handleTransportFrame(frame: TransportFrame): Promise<void> {
    if (this.closed) return;
    assertPostHandshakeEnvelope(frame);
    assertEnvelopeScope(frame, this.runId, this.instanceId);
    if (frame.controllerEpoch !== this.controllerEpoch) throw this.staleEpoch(frame.controllerEpoch);
    if (frame.type === "channel.ack") {
      await this.outbox.ackThrough((frame.payload as ChannelAck).throughSeq);
      return;
    }
    const expected = (frame.payload as ChannelNack).expectedSeq;
    if ((frame.payload as ChannelNack).reason === "invalid") {
      throw new WorkerSessionProtocolError("controller rejected worker output", CLOSE_CODE_SCOPE_MISMATCH);
    }
    const active = this.active;
    if (!active) return;
    await this.queueSend(async () => {
      const replay = await this.outbox.listAfter(expected - 1);
      for (const event of replay) await this.send(active.transport, event as unknown as WireFrame);
    });
  }

  private staleEpoch(epoch: number): WorkerSessionProtocolError {
    return new WorkerSessionProtocolError(
      `controller epoch ${epoch} is fenced by ${this.controllerEpoch}`,
      CLOSE_CODE_STALE_CONTROLLER_EPOCH,
    );
  }

  private async sendCommandAck(throughSeq: number): Promise<void> {
    const active = this.active;
    if (!active) return;
    const frame: WireFrame = {
      v: 1,
      type: "channel.ack",
      id: randomUUID(),
      runId: this.runId,
      instanceId: this.instanceId,
      controllerEpoch: active.epoch,
      seq: 0,
      sentAt: new Date().toISOString(),
      payload: { throughSeq },
    };
    await this.queueSend(() => this.send(active.transport, frame));
  }

  private async sendCommandNack(expectedSeq: number): Promise<void> {
    const active = this.active;
    if (!active) return;
    const frame: WireFrame = {
      v: 1,
      type: "channel.nack",
      id: randomUUID(),
      runId: this.runId,
      instanceId: this.instanceId,
      controllerEpoch: active.epoch,
      seq: 0,
      sentAt: new Date().toISOString(),
      payload: { expectedSeq, reason: "gap" },
    };
    await this.queueSend(() => this.send(active.transport, frame));
  }

  private queueSend(operation: () => Promise<void>): Promise<void> {
    const next = this.sendTail.then(operation);
    this.sendTail = next.catch(() => undefined);
    return next;
  }

  private async send(
    transport: WorkerSessionTransport | ((frame: WireFrame) => Promise<void> | void),
    frame: WireFrame,
  ): Promise<void> {
    try {
      await asTransport(transport).send(frame);
    } catch (error) {
      if (this.active?.transport === transport) this.detachTransport(transport);
      throw error;
    }
  }

  private detachTransport(transport: ActiveTransport["transport"]): void {
    if (this.active?.transport === transport) this.active = undefined;
  }

  private async closeTransport(
    transport: ActiveTransport["transport"],
    code: number,
    reason: string,
  ): Promise<void> {
    const close = asTransport(transport).close;
    if (close) await close.call(asTransport(transport), code, reason);
  }
}

