import { access } from "node:fs/promises";
import {
  BLOB_HEADER_BYTES,
  BlobReceiver,
  BlobValidationError,
  chunkBlob,
  decodeBlobChunk,
  validateBlobOpen,
  type BlobChunkFrame,
  type BlobOpen,
} from "./blob";
import {
  DEFAULT_MAX_IN_FLIGHT_BYTES,
  type BlobAcceptedMessage,
  type BlobOpenMessage,
  type BlobRef,
  type BlobRejectedMessage,
} from "./protocol";

/** Default ceiling on distinct incoming blob transfers open at once. Each open
 * transfer can spool up to BLOB_MAX_SIZE_BYTES (25 MiB) of `.part` bytes, so
 * this bounds worst-case disk use for one channel (8 × 25 MiB) and refuses a
 * misbehaving peer that opens unbounded unique blobIds. */
export const DEFAULT_MAX_CONCURRENT_INCOMING = 8;

/**
 * Wire integration for the blob transfer mechanism (plan section 16). One
 * coordinator instance lives on each side of a channel. It ties together:
 *
 *  - outgoing transfers: `sendBlob` announces a `blob.open`, then streams binary
 *    chunk frames once the peer's `blob.accepted { nextChunk }` selects a resume
 *    point, and resolves when `blob.accepted { complete: true }` arrives;
 *  - incoming transfers: `onBlobOpen` drives the durable {@link BlobReceiver},
 *    `onBinary` applies chunks and, on the final verified chunk, replies
 *    `blob.accepted { complete: true }` (or `blob.rejected` on a digest/size
 *    violation, which is a protocol violation that also closes the channel).
 *
 * The JSON messages themselves are ordinary sequenced envelopes; how each side
 * actually enqueues them (worker event vs. persisted command) is injected as the
 * {@link BlobWireIO}. Only the binary chunk frames are unsequenced.
 *
 * Backpressure (defect fix): the pump does not fire chunks off back-to-back.
 * It keeps at most `maxInFlightBytes` (default {@link DEFAULT_MAX_IN_FLIGHT_BYTES},
 * 8 MiB) of chunk *data* in flight — bytes sent but not yet confirmed by the
 * peer — and parks when the budget is full. The receiver releases the budget by
 * echoing a periodic `blob.accepted { complete: false, nextChunk }` window ack
 * once it has durably persisted roughly half a window of new bytes (this is the
 * "chunk bytes count toward maxInFlightBytes" rule in the protocol doc; it is a
 * *window* ack, coarser than per-chunk). A parked pump resumes when such an ack
 * (or a reconnect resume cursor) frees the budget. Because chunks are applied
 * strictly in order and the receiver rejects any chunk ahead of its cursor, the
 * in-flight set is always the contiguous range `[acked, cursor)`.
 */
export interface BlobWireIO {
  sendBlobOpen(message: BlobOpenMessage): Promise<void> | void;
  sendBlobAccepted(message: BlobAcceptedMessage): Promise<void> | void;
  sendBlobRejected(message: BlobRejectedMessage): Promise<void> | void;
  /** Send one encoded binary chunk frame. */
  sendBinary(frame: Buffer): Promise<void> | void;
}

/** A digest/size violation while receiving a blob. Closes the channel with 4403
 * per the protocol design's Blob transfer section. */
export class BlobProtocolViolation extends Error {
  readonly closeCode = 4403;
  constructor(message: string) {
    super(message);
    this.name = "BlobProtocolViolation";
  }
}

/** Chunk-data byte count of an encoded frame (frame minus its fixed header). */
function frameDataBytes(frame: Buffer): number {
  return Math.max(0, frame.length - BLOB_HEADER_BYTES);
}

interface OutgoingTransfer {
  meta: BlobOpen;
  frames: Buffer[];
  /** Next chunk index to send. A resume (or reconnect) rewinds this to the
   * receiver's persisted cursor. */
  cursor: number;
  /** Next chunk index the receiver has confirmed. Chunks in `[acked, cursor)`
   * are in flight and count against `maxInFlightBytes`. */
  acked: number;
  /** Running sum of in-flight chunk *data* bytes (the `[acked, cursor)` range). */
  inFlightBytes: number;
  /** The next `complete: false` accepted rewinds the cursor and resets the
   * in-flight window: set for a fresh open and after every reconnect rebind.
   * While set, the pump parks rather than sending, so a stale post-reconnect
   * chunk is never sent ahead of the receiver's persisted cursor. */
  awaitingResume: boolean;
  /** Single-flight guard: a resume that arrives during an active pump just moves
   * the cursor; it does not start a second, interleaving pump. */
  pumping: boolean;
  /** Resolver for a pump parked on the in-flight budget (or on `awaitingResume`). */
  budgetWaiter?: () => void;
  resolve(): void;
  reject(error: unknown): void;
  settled: boolean;
}

export class BlobCoordinator {
  private readonly receiver: BlobReceiver;
  private io: BlobWireIO;
  private readonly maxInFlightBytes: number;
  private readonly maxConcurrentIncoming: number;
  /** Bytes a receiver may durably persist before it echoes a window ack. Kept
   * below `maxInFlightBytes` so the sender's parked pump is always released
   * before it fully stalls. */
  private readonly ackThresholdBytes: number;
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly completed = new Set<string>();
  private readonly completionWaiters = new Map<string, Array<() => void>>();
  /** In-progress incoming transfers keyed by blobId, for the concurrency cap and
   * window-ack accounting. Entries live from `blob.open` until completion,
   * rejection, or protocol violation. */
  private readonly incoming = new Map<string, { unackedBytes: number }>();

  constructor(
    sessionRoot: string,
    io: BlobWireIO,
    maxInFlightBytes = DEFAULT_MAX_IN_FLIGHT_BYTES,
    maxConcurrentIncoming = DEFAULT_MAX_CONCURRENT_INCOMING,
  ) {
    this.receiver = new BlobReceiver(sessionRoot);
    this.io = io;
    this.maxInFlightBytes = maxInFlightBytes;
    this.maxConcurrentIncoming = maxConcurrentIncoming;
    this.ackThresholdBytes = Math.max(1, Math.floor(maxInFlightBytes / 2));
  }

  /** Swap the transport after a reconnect and re-announce any pending outgoing
   * blob so the receiver replies with its persisted resume cursor. */
  async rebind(io: BlobWireIO): Promise<void> {
    this.io = io;
    for (const transfer of this.outgoing.values()) {
      if (!transfer.settled) {
        // The in-flight window from the dead connection is void: chunks buffered
        // in the old socket never landed. Park the pump on `awaitingResume` so it
        // sends nothing until the receiver's re-open reply supplies the persisted
        // resume cursor (which the pump then adopts and streams from).
        transfer.awaitingResume = true;
        // Re-announce; the receiver's blob.accepted reply carries the authoritative
        // resume cursor, which the pump adopts.
        await this.io.sendBlobOpen(this.openMessage(transfer.meta));
      }
    }
  }

  /** Bytes counted against the negotiated in-flight window (blob chunk bytes
   * count toward `maxInFlightBytes`): the aggregate of every outgoing transfer's
   * sent-but-unacked chunk data. Never exceeds `maxInFlightBytes` per transfer. */
  get inFlight(): number {
    let total = 0;
    for (const transfer of this.outgoing.values()) total += transfer.inFlightBytes;
    return total;
  }

  /**
   * Send a blob to `complete` and resolve. A caller MUST await this before it
   * emits the message that references the blob (the sender-completes-before-
   * referencing ordering rule).
   */
  sendBlob(ref: Omit<BlobRef, "type">, data: Buffer): Promise<void> {
    const meta: BlobOpen = {
      blobId: ref.blobId.toLowerCase(),
      size: ref.size,
      sha256: ref.sha256.toLowerCase(),
      mimeType: ref.mimeType,
      purpose: ref.purpose,
    };
    if (data.length !== meta.size) {
      return Promise.reject(new BlobValidationError("blob data length does not match declared size"));
    }
    const frames = chunkBlob(meta.blobId, data);
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const transfer: OutgoingTransfer = {
      meta,
      frames,
      cursor: 0,
      acked: 0,
      inFlightBytes: 0,
      awaitingResume: true,
      pumping: false,
      resolve,
      reject,
      settled: false,
    };
    this.outgoing.set(meta.blobId, transfer);
    // Announce; binary streaming begins when the peer's blob.accepted selects a
    // resume cursor (0 for a fresh blob).
    void Promise.resolve(this.io.sendBlobOpen(this.openMessage(meta))).catch((error) => {
      transfer.settled = true;
      this.outgoing.delete(meta.blobId);
      reject(error);
    });
    return done;
  }

  /** Handle a `blob.accepted` reply for a blob this side is sending. Serves both
   * the resume cursor (fresh open / reconnect) and periodic window acks that
   * release the in-flight budget. */
  onBlobAccepted(message: BlobAcceptedMessage): void {
    const transfer = this.outgoing.get(message.blobId.toLowerCase());
    if (!transfer || transfer.settled) return;
    if (message.complete) {
      transfer.settled = true;
      this.outgoing.delete(transfer.meta.blobId);
      // Release a parked pump so its loop observes `settled` and exits.
      this.wakeBudget(transfer);
      transfer.resolve();
      return;
    }

    const next = Math.max(0, Math.min(message.nextChunk, transfer.frames.length));
    if (transfer.awaitingResume) {
      // Authoritative resume cursor: rewind and reset the in-flight window.
      transfer.awaitingResume = false;
      transfer.cursor = next;
      transfer.acked = next;
      transfer.inFlightBytes = 0;
    } else if (next > transfer.acked) {
      // Window ack: retire the confirmed chunks from the in-flight budget.
      let freed = 0;
      for (let i = transfer.acked; i < next; i++) freed += frameDataBytes(transfer.frames[i]);
      transfer.acked = next;
      transfer.inFlightBytes = Math.max(0, transfer.inFlightBytes - freed);
    }

    // Start the pump if idle; otherwise release it if it is parked on budget.
    if (!transfer.pumping) this.startPump(transfer);
    else this.wakeBudget(transfer);
  }

  /** Handle a `blob.rejected` reply for a blob this side is sending. */
  onBlobRejected(message: BlobRejectedMessage): void {
    const transfer = this.outgoing.get(message.blobId.toLowerCase());
    if (!transfer || transfer.settled) return;
    transfer.settled = true;
    this.outgoing.delete(transfer.meta.blobId);
    this.wakeBudget(transfer);
    transfer.reject(new BlobProtocolViolation(`peer rejected blob ${transfer.meta.blobId}: ${message.reason}`));
  }

  /** Handle an incoming `blob.open`: open (or resume) the durable receiver and
   * reply with the resume cursor, or `complete` if it was already received. */
  async onBlobOpen(message: BlobOpenMessage): Promise<void> {
    const meta = validateBlobOpen(message);
    if (await this.finalExists(meta.blobId)) {
      this.completed.add(meta.blobId);
      this.incoming.delete(meta.blobId);
      this.resolveCompletion(meta.blobId);
      await this.io.sendBlobAccepted({ blobId: meta.blobId, nextChunk: 0, complete: true });
      return;
    }
    // Cap distinct concurrent incoming transfers so a misbehaving peer cannot
    // open N unique blobIds and spool N × 25 MiB of `.part` files. A re-open of
    // an already-tracked blob (reconnect resume) does not consume a new slot.
    if (!this.incoming.has(meta.blobId)) {
      if (this.incoming.size >= this.maxConcurrentIncoming) {
        await this.io.sendBlobRejected({
          blobId: meta.blobId,
          reason: `too many concurrent blob transfers (max ${this.maxConcurrentIncoming})`,
        });
        return;
      }
      this.incoming.set(meta.blobId, { unackedBytes: 0 });
    }
    const { resumeFromChunk } = await this.receiver.open(meta);
    await this.io.sendBlobAccepted({ blobId: meta.blobId, nextChunk: resumeFromChunk, complete: false });
  }

  /** Handle one incoming binary chunk frame. */
  async onBinary(frame: Buffer): Promise<void> {
    let chunk: BlobChunkFrame;
    try {
      chunk = decodeBlobChunk(frame);
    } catch (error) {
      throw new BlobProtocolViolation(error instanceof Error ? error.message : "malformed blob chunk");
    }
    let accept;
    try {
      accept = await this.receiver.acceptChunk(chunk);
    } catch (error) {
      // A digest/size mismatch or missing-chunk gap is a protocol violation. The
      // receiver has already discarded a bad-digest partial.
      this.incoming.delete(chunk.blobId);
      const reason = error instanceof Error ? error.message : "blob chunk rejected";
      await this.io.sendBlobRejected({ blobId: chunk.blobId, reason });
      throw new BlobProtocolViolation(reason);
    }
    if (accept.completed) {
      this.incoming.delete(chunk.blobId);
      this.completed.add(chunk.blobId);
      await this.io.sendBlobAccepted({ blobId: chunk.blobId, nextChunk: accept.nextChunk, complete: true });
      this.resolveCompletion(chunk.blobId);
      return;
    }
    // Window ack: accumulate durably-persisted bytes and, once half a window has
    // landed, echo the cursor so the sender's parked pump can advance. This is
    // the receive-side leg of "chunk bytes count toward maxInFlightBytes". A
    // duplicate (idempotent) chunk carries no new bytes and never over-acks.
    const state = this.incoming.get(chunk.blobId);
    // A freshly accepted chunk advances the cursor to exactly chunkNumber + 1; a
    // duplicate reports a higher cursor and wrote no bytes, so it is excluded.
    if (state && accept.nextChunk === chunk.chunkNumber + 1) {
      state.unackedBytes += chunk.data.length;
      if (state.unackedBytes >= this.ackThresholdBytes) {
        state.unackedBytes = 0;
        await this.io.sendBlobAccepted({ blobId: chunk.blobId, nextChunk: accept.nextChunk, complete: false });
      }
    }
  }

  /** Resolve once the named incoming blob has been fully received and verified. */
  awaitIncoming(blobId: string): Promise<void> {
    const id = blobId.toLowerCase();
    if (this.completed.has(id)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.completionWaiters.get(id) ?? [];
      waiters.push(resolve);
      this.completionWaiters.set(id, waiters);
    });
  }

  isComplete(blobId: string): boolean {
    return this.completed.has(blobId.toLowerCase());
  }

  /** Absolute path a completed incoming blob was renamed to. */
  pathFor(blobId: string): string {
    return this.receiver.finalPathFor(blobId.toLowerCase());
  }

  /** Start the single detached pump loop for a transfer (no-op if one already
   * runs). It streams chunks while `[acked, cursor)` stays within
   * `maxInFlightBytes`, parking on the budget (or on `awaitingResume`) otherwise.
   * Kept detached so a parked pump never blocks the frame handler that drives
   * {@link onBlobAccepted}. */
  private startPump(transfer: OutgoingTransfer): void {
    if (transfer.pumping || transfer.settled) return;
    transfer.pumping = true;
    void (async () => {
      try {
        while (!transfer.settled && transfer.cursor < transfer.frames.length) {
          // Hold everything until the reconnect resume cursor arrives, so no
          // chunk is sent ahead of the receiver's persisted position.
          if (transfer.awaitingResume) {
            await this.waitForBudget(transfer);
            continue;
          }
          const i = transfer.cursor;
          const size = frameDataBytes(transfer.frames[i]);
          // Always allow at least one in-flight chunk (a single 64 KiB chunk can
          // never exceed the 8 MiB window); otherwise gate on the budget.
          if (transfer.inFlightBytes > 0 && transfer.inFlightBytes + size > this.maxInFlightBytes) {
            await this.waitForBudget(transfer);
            continue;
          }
          await this.io.sendBinary(transfer.frames[i]);
          if (transfer.settled) break;
          // Only advance if a concurrent resume did not rewind the cursor.
          if (transfer.cursor === i && !transfer.awaitingResume) {
            transfer.cursor = i + 1;
            transfer.inFlightBytes += size;
          }
        }
      } catch (error) {
        if (!transfer.settled) {
          transfer.settled = true;
          this.outgoing.delete(transfer.meta.blobId);
          transfer.reject(error);
        }
      } finally {
        transfer.pumping = false;
      }
    })();
  }

  /** Park the pump until {@link wakeBudget} releases it. */
  private waitForBudget(transfer: OutgoingTransfer): Promise<void> {
    return new Promise<void>((resolve) => {
      transfer.budgetWaiter = resolve;
    });
  }

  /** Release a pump parked in {@link waitForBudget}. Safe to call when none is
   * parked (no-op). */
  private wakeBudget(transfer: OutgoingTransfer): void {
    const waiter = transfer.budgetWaiter;
    if (waiter) {
      transfer.budgetWaiter = undefined;
      waiter();
    }
  }

  private openMessage(meta: BlobOpen): BlobOpenMessage {
    return {
      blobId: meta.blobId,
      size: meta.size,
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      purpose: meta.purpose,
    };
  }

  private resolveCompletion(blobId: string): void {
    const waiters = this.completionWaiters.get(blobId);
    if (!waiters) return;
    this.completionWaiters.delete(blobId);
    for (const resolve of waiters) resolve();
  }

  private async finalExists(blobId: string): Promise<boolean> {
    try {
      await access(this.receiver.finalPathFor(blobId));
      return true;
    } catch {
      return false;
    }
  }
}

/** Collect blob references embedded in a message content array (or any nested
 * value) so the receiver can enforce the ordering rule. */
export function collectBlobRefs(value: unknown, out: BlobRef[] = []): BlobRef[] {
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "blob" && typeof record.blobId === "string") {
      out.push(record as unknown as BlobRef);
      return out;
    }
    for (const key of Object.keys(record)) collectBlobRefs(record[key], out);
  }
  return out;
}
