import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import type { FileHandle } from "node:fs/promises";

/**
 * The spool deliberately only depends on the envelope fields it needs.  The
 * full protocol union can be used by callers without making this worker-side
 * persistence module depend on the control-plane protocol implementation.
 */
export interface WorkerEvent {
  v?: number;
  type: string;
  id: string;
  runId: number;
  instanceId: string;
  controllerEpoch?: number;
  seq: number;
  sentAt?: string;
  replyTo?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export interface WorkerOutboxOptions {
  /** Maximum number of unacknowledged serialized frame bytes. */
  maxInFlightBytes?: number;
}

interface StoredEvent {
  frame: WorkerEvent;
  /** The JSON object line without its trailing newline. */
  line: string;
  bytes: number;
  hash: string;
}

interface PersistedState {
  version: 1;
  runId: number;
  instanceId: string;
  /** The next sequence that may be allocated. This is a high-water mark. */
  nextSeq: number;
  ackThrough: number;
  ackedFrameCount: number;
  reclaimableBytes: number;
  eventHashes: Record<string, string>;
  maxInFlightBytes?: number;
}

const CHANNEL_DIR = "channel";
export const OUTBOX_FILENAME = "outbox.jsonl";
export const STATE_FILENAME = "state.json";
const OUTBOX_TEMP_FILENAME = `${OUTBOX_FILENAME}.tmp`;
const STATE_TEMP_FILENAME = `${STATE_FILENAME}.tmp`;

export const DEFAULT_MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
export const COMPACT_ACKED_FRAMES = 1_000;
export const COMPACT_RECLAIMABLE_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function assertScope(runId: number, instanceId: string, frame: WorkerEvent): void {
  if (frame.runId !== runId || frame.instanceId !== instanceId) {
    throw new Error("worker event scope mismatch");
  }
}

function validateEvent(value: unknown, runId: number, instanceId: string): WorkerEvent {
  if (!isRecord(value)) throw new Error("worker outbox line must be a JSON object");

  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("worker event id must be a non-empty string");
  }
  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new Error("worker event type must be a non-empty string");
  }
  assertPositiveSafeInteger(value.seq, "worker event seq");
  if (typeof value.runId !== "number" || !Number.isSafeInteger(value.runId)) {
    throw new Error("worker event runId must be a safe integer");
  }
  if (typeof value.instanceId !== "string" || value.instanceId.length === 0) {
    throw new Error("worker event instanceId must be a non-empty string");
  }

  const frame = value as WorkerEvent;
  assertScope(runId, instanceId, frame);
  return frame;
}

/** JSON.stringify with recursively sorted object keys for stable identity. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) throw new Error("worker event is not JSON serializable");
    return primitive;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${entries.join(",")}}`;
}

function eventHash(frame: WorkerEvent): string {
  return createHash("sha256").update(canonicalJson(frame), "utf8").digest("hex");
}

function serializeEvent(frame: WorkerEvent): { line: string; bytes: number; hash: string } {
  const line = JSON.stringify(frame);
  if (line === undefined) throw new Error("worker event is not JSON serializable");
  return {
    line,
    bytes: Buffer.byteLength(line, "utf8") + 1,
    hash: eventHash(frame),
  };
}

function cloneEvent(frame: WorkerEvent): WorkerEvent {
  return JSON.parse(JSON.stringify(frame)) as WorkerEvent;
}

async function writeAll(handle: FileHandle, data: string | Buffer): Promise<void> {
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw new Error("failed to write worker outbox data");
    offset += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function parseMaxInFlightBytes(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_IN_FLIGHT_BYTES;
  assertPositiveSafeInteger(value, "maxInFlightBytes");
  return value;
}

function parseState(value: unknown, runId: number, instanceId: string): PersistedState {
  if (!isRecord(value)) throw new Error("worker outbox state must be a JSON object");
  if (value.version !== 1) throw new Error("unsupported worker outbox state version");
  if (value.runId !== runId || value.instanceId !== instanceId) {
    throw new Error("worker outbox state scope mismatch");
  }

  assertPositiveSafeInteger(value.nextSeq, "worker outbox nextSeq");
  assertNonNegativeSafeInteger(value.ackThrough, "worker outbox ackThrough");
  assertNonNegativeSafeInteger(value.ackedFrameCount, "worker outbox ackedFrameCount");
  assertNonNegativeSafeInteger(value.reclaimableBytes, "worker outbox reclaimableBytes");

  const eventHashes: Record<string, string> = Object.create(null) as Record<string, string>;
  if (value.eventHashes !== undefined) {
    if (!isRecord(value.eventHashes)) throw new Error("worker outbox eventHashes must be an object");
    for (const [id, hash] of Object.entries(value.eventHashes)) {
      if (typeof hash !== "string" || hash.length === 0) {
        throw new Error(`invalid worker outbox hash for event ${id}`);
      }
      eventHashes[id] = hash;
    }
  }

  const maxInFlightBytes = value.maxInFlightBytes === undefined
    ? undefined
    : parseMaxInFlightBytes(value.maxInFlightBytes);

  return {
    version: 1,
    runId,
    instanceId,
    nextSeq: value.nextSeq,
    ackThrough: value.ackThrough,
    ackedFrameCount: value.ackedFrameCount,
    reclaimableBytes: value.reclaimableBytes,
    eventHashes,
    ...(maxInFlightBytes === undefined ? {} : { maxInFlightBytes }),
  };
}

function initialState(runId: number, instanceId: string, maxInFlightBytes: number): PersistedState {
  return {
    version: 1,
    runId,
    instanceId,
    nextSeq: 1,
    ackThrough: 0,
    ackedFrameCount: 0,
    reclaimableBytes: 0,
    eventHashes: Object.create(null) as Record<string, string>,
    maxInFlightBytes,
  };
}

/**
 * Durable worker-side JSONL outbox.  All file mutations are serialized, but
 * capacity waits do not hold that mutation queue: an acknowledgement can
 * therefore release a blocked producer.
 */
export class WorkerOutbox {
  static async open(
    root: string,
    runId: number,
    instanceId: string,
    options: WorkerOutboxOptions | number = {},
  ): Promise<WorkerOutbox> {
    if (typeof root !== "string" || root.length === 0) throw new Error("worker outbox root is required");
    if (typeof runId !== "number" || !Number.isSafeInteger(runId)) {
      throw new Error("worker outbox runId must be a safe integer");
    }
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new Error("worker outbox instanceId is required");
    }

    const requestedMax = typeof options === "number" ? options : options.maxInFlightBytes;
    const channel = join(root, CHANNEL_DIR);
    const outboxPath = join(channel, OUTBOX_FILENAME);
    const statePath = join(channel, STATE_FILENAME);
    await mkdir(channel, { recursive: true, mode: 0o700 });
    await chmod(channel, 0o700);
    // A crashed compaction never invalidates the old outbox; discard only its
    // uncommitted temporary file when opening.
    await removeIfPresent(join(channel, OUTBOX_TEMP_FILENAME));
    await removeIfPresent(join(channel, STATE_TEMP_FILENAME));

    let state: PersistedState;
    try {
      state = parseState(JSON.parse(await readFile(statePath, "utf8")), runId, instanceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = initialState(runId, instanceId, parseMaxInFlightBytes(requestedMax));
    }

    const maxInFlightBytes = parseMaxInFlightBytes(requestedMax ?? state.maxInFlightBytes);
    state.maxInFlightBytes = maxInFlightBytes;

    let outboxData = "";
    try {
      outboxData = await readFile(outboxPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const events: StoredEvent[] = [];
    const ids = new Map<string, string>();
    const lineIds = new Set<string>();
    for (const [id, hash] of Object.entries(state.eventHashes)) ids.set(id, hash);

    const lines = outboxData.split("\n");
    const hasTerminalNewline = outboxData.endsWith("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const isLast = index === lines.length - 1;
      if (outboxData.length === 0 && isLast) continue;
      if (isLast && hasTerminalNewline && line === "") continue;
      if (line.length === 0) {
        throw new Error(`empty or corrupt worker outbox line ${index + 1}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        // A write can be torn after its JSON bytes but before its newline. It
        // is the sole recoverable case. A newline makes the line complete and
        // therefore any parse failure is fatal.
        if (isLast && !hasTerminalNewline) continue;
        throw new Error(`corrupt complete worker outbox line ${index + 1}`, { cause: error });
      }

      const frame = validateEvent(parsed, runId, instanceId);
      const serialized = serializeEvent(frame);
      const hash = serialized.hash;
      const previousHash = ids.get(frame.id);
      if (previousHash !== undefined && previousHash !== hash) {
        throw new Error(`worker event id ${frame.id} was reused with different contents`);
      }
      if (lineIds.has(frame.id)) {
        // A byte-for-byte duplicate can be left by a crash/retry. It is
        // idempotent and must not become two replayed events.
        continue;
      }
      ids.set(frame.id, hash);
      lineIds.add(frame.id);
      events.push({ frame, line, bytes: Buffer.byteLength(`${line}\n`, "utf8"), hash });
    }

    let previousSeq = 0;
    let highestSeq = 0;
    let inFlightBytes = 0;
    for (const event of events) {
      if (event.frame.seq <= previousSeq) {
        throw new Error("worker outbox sequence is not strictly monotonic");
      }
      previousSeq = event.frame.seq;
      highestSeq = Math.max(highestSeq, event.frame.seq);
      if (event.frame.seq > state.ackThrough) inFlightBytes += event.bytes;
    }

    // If state.json was written after a line became durable, recover the line;
    // if state.json was written first, preserve its high-water mark and never
    // reuse the possibly exposed sequence.
    state.nextSeq = Math.max(state.nextSeq, highestSeq + 1);
    for (const [id, hash] of ids) state.eventHashes[id] = hash;

    const handle = await open(outboxPath, "a+", 0o600);
    await chmod(outboxPath, 0o600);
    const outbox = new WorkerOutbox(
      channel,
      outboxPath,
      statePath,
      handle,
      state,
      events,
      inFlightBytes,
      maxInFlightBytes,
    );
    await outbox.persistState();
    await outbox.compactIfNeeded();
    return outbox;
  }

  private readonly channelPath: string;
  private readonly outboxPath: string;
  private readonly statePath: string;
  private outboxHandle: FileHandle | undefined;
  private state: PersistedState;
  private events: StoredEvent[];
  private inFlight: number;
  private maxBytes: number;
  private reservedBytes = 0;
  private ioTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private capacityWaiters: Array<{
    bytes: number;
    resolve: () => void;
    reject: (reason: unknown) => void;
  }> = [];

  private constructor(
    channelPath: string,
    outboxPath: string,
    statePath: string,
    handle: FileHandle,
    state: PersistedState,
    events: StoredEvent[],
    inFlight: number,
    maxBytes: number,
  ) {
    this.channelPath = channelPath;
    this.outboxPath = outboxPath;
    this.statePath = statePath;
    this.outboxHandle = handle;
    this.state = state;
    this.events = events;
    this.inFlight = inFlight;
    this.maxBytes = maxBytes;
  }

  /** Number of unacknowledged serialized JSONL bytes. */
  bytesInFlight(): number {
    return this.inFlight;
  }

  /** Session volume root (the parent of the `channel/` directory), used to
   * anchor the sibling `channel/blobs` blob store. */
  sessionRoot(): string {
    return dirname(this.channelPath);
  }

  /** The next worker-lifetime sequence, including across restarts. */
  nextSeq(): number {
    return this.state.nextSeq;
  }

  get maxInFlightBytes(): number {
    return this.maxBytes;
  }

  /** Update the negotiated receive window and wake producers if possible. */
  setMaxInFlightBytes(value: number): void {
    this.maxBytes = parseMaxInFlightBytes(value);
    this.state.maxInFlightBytes = this.maxBytes;
    void this.enqueueIo(async () => {
      await this.persistState();
    }).catch((error) => this.rejectCapacityWaiters(error));
    this.signalCapacity();
  }

  /** Resolve when a frame of `bytes` can fit under the current receive window. */
  async waitForCapacity(bytes = 0): Promise<void> {
    assertNonNegativeSafeInteger(bytes, "capacity bytes");
    if (bytes > this.maxBytes) {
      throw new Error("worker event is larger than maxInFlightBytes");
    }
    if (this.closed) throw new Error("worker outbox is closed");
    if (this.inFlight + this.reservedBytes + bytes <= this.maxBytes) return;

    await new Promise<void>((resolve, reject) => {
      this.capacityWaiters.push({ bytes, resolve, reject });
    });
  }

  /** Alias for callers that prefer the protocol's await-capacity terminology. */
  awaitCapacity(bytes = 0): Promise<void> {
    return this.waitForCapacity(bytes);
  }

  async append(frame: WorkerEvent): Promise<void> {
    const validated = validateEvent(frame, this.state.runId, this.state.instanceId);
    const serialized = serializeEvent(validated);
    const existingHash = this.state.eventHashes[validated.id];
    if (existingHash !== undefined) {
      if (existingHash !== serialized.hash) {
        throw new Error(`worker event id ${validated.id} was reused with different contents`);
      }
      return;
    }
    if (serialized.bytes > this.maxBytes) {
      throw new Error("worker event is larger than maxInFlightBytes");
    }

    await this.reserveCapacity(serialized.bytes);
    try {
      await this.enqueueIo(async () => {
        if (this.closed) throw new Error("worker outbox is closed");
        const currentHash = this.state.eventHashes[validated.id];
        if (currentHash !== undefined) {
          if (currentHash !== serialized.hash) {
            throw new Error(`worker event id ${validated.id} was reused with different contents`);
          }
          return;
        }
        if (validated.seq !== this.state.nextSeq) {
          throw new Error(
            `worker event sequence ${validated.seq} is not the next sequence ${this.state.nextSeq}`,
          );
        }
        const handle = this.outboxHandle;
        if (!handle) throw new Error("worker outbox is closed");
        await writeAll(handle, `${serialized.line}\n`);
        await handle.sync();

        const stored: StoredEvent = {
          frame: cloneEvent(validated),
          line: serialized.line,
          bytes: serialized.bytes,
          hash: serialized.hash,
        };
        this.events.push(stored);
        this.state.eventHashes[validated.id] = serialized.hash;
        this.state.nextSeq += 1;
        this.inFlight += serialized.bytes;
        await this.persistState();
      });
    } finally {
      this.reservedBytes -= serialized.bytes;
      this.signalCapacity();
    }
  }

  async listAfter(seq: number): Promise<WorkerEvent[]> {
    assertNonNegativeSafeInteger(seq, "replay sequence");
    return this.events
      .filter((event) => event.frame.seq > seq && event.frame.seq > this.state.ackThrough)
      .map((event) => cloneEvent(event.frame));
  }

  async ackThrough(seq: number): Promise<void> {
    assertNonNegativeSafeInteger(seq, "ack sequence");
    await this.enqueueIo(async () => {
      if (this.closed) throw new Error("worker outbox is closed");
      const highestDurable = this.state.nextSeq - 1;
      const through = Math.min(seq, highestDurable);
      if (through <= this.state.ackThrough) return;

      const prior = this.state.ackThrough;
      let reclaimed = 0;
      let acked = 0;
      for (const event of this.events) {
        if (event.frame.seq > prior && event.frame.seq <= through) {
          reclaimed += event.bytes;
          acked += 1;
        }
      }
      this.state.ackThrough = through;
      this.state.ackedFrameCount += acked;
      this.state.reclaimableBytes += reclaimed;
      this.inFlight = Math.max(0, this.inFlight - reclaimed);
      await this.persistState();
      await this.compactIfNeeded();
      this.signalCapacity();
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.rejectCapacityWaiters(new Error("worker outbox is closed"));
    this.closePromise = this.ioTail.then(async () => {
      const handle = this.outboxHandle;
      this.outboxHandle = undefined;
      if (handle) await handle.close();
    });
    return this.closePromise;
  }

  private enqueueIo(operation: () => Promise<void>): Promise<void> {
    const result = this.ioTail.then(operation);
    this.ioTail = result.catch(() => undefined);
    return result;
  }

  private async reserveCapacity(bytes: number): Promise<void> {
    if (bytes > this.maxBytes) {
      throw new Error("worker event is larger than maxInFlightBytes");
    }
    while (true) {
      if (this.closed) throw new Error("worker outbox is closed");
      // There is no await between this check and the reservation. This makes
      // concurrent append calls account for one another before they yield.
      if (this.inFlight + this.reservedBytes + bytes <= this.maxBytes) {
        this.reservedBytes += bytes;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        this.capacityWaiters.push({ bytes, resolve, reject });
      });
    }
  }

  private stateForDisk(): PersistedState {
    return {
      ...this.state,
      eventHashes: Object.fromEntries(Object.entries(this.state.eventHashes)),
    };
  }

  private async persistState(): Promise<void> {
    const temporaryPath = join(this.channelPath, STATE_TEMP_FILENAME);
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await writeAll(handle, `${JSON.stringify(this.stateForDisk())}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.statePath);
    await syncDirectory(this.channelPath);
    await chmod(this.statePath, 0o600);
  }

  private async compactIfNeeded(): Promise<void> {
    if (
      this.state.ackedFrameCount < COMPACT_ACKED_FRAMES &&
      this.state.reclaimableBytes < COMPACT_RECLAIMABLE_BYTES
    ) {
      return;
    }

    const retained = this.events.filter((event) => event.frame.seq > this.state.ackThrough);
    const temporaryPath = join(this.channelPath, OUTBOX_TEMP_FILENAME);
    const temporaryHandle = await open(temporaryPath, "w", 0o600);
    try {
      for (const event of retained) await writeAll(temporaryHandle, `${event.line}\n`);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await chmod(temporaryPath, 0o600);

    const currentHandle = this.outboxHandle;
    this.outboxHandle = undefined;
    try {
      if (currentHandle) await currentHandle.close();
      await rename(temporaryPath, this.outboxPath);
      await syncDirectory(this.channelPath);
      const reopened = await open(this.outboxPath, "a+", 0o600);
      await chmod(this.outboxPath, 0o600);
      this.outboxHandle = reopened;
    } catch (error) {
      if (!this.outboxHandle) {
        try {
          this.outboxHandle = await open(this.outboxPath, "a+", 0o600);
        } catch {
          // Preserve the original compaction error; close/open will surface
          // the inability to continue using the outbox.
        }
      }
      throw error;
    }

    this.events = retained;
    this.state.ackedFrameCount = 0;
    this.state.reclaimableBytes = 0;
    await this.persistState();
  }

  private signalCapacity(): void {
    if (this.closed) return;
    const remaining: typeof this.capacityWaiters = [];
    for (const waiter of this.capacityWaiters) {
      if (this.inFlight + this.reservedBytes + waiter.bytes <= this.maxBytes) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.capacityWaiters = remaining;
  }

  private rejectCapacityWaiters(reason: unknown): void {
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const waiter of waiters) waiter.reject(reason);
  }
}

export const openWorkerOutbox = WorkerOutbox.open.bind(WorkerOutbox);
