import { access } from "node:fs/promises";
import {
  BlobReceiver,
  BlobValidationError,
  chunkBlob,
  decodeBlobChunk,
  validateBlobOpen,
  type BlobChunkFrame,
  type BlobOpen,
} from "./blob";
import type {
  BlobAcceptedMessage,
  BlobOpenMessage,
  BlobRef,
  BlobRejectedMessage,
} from "./protocol";

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

interface OutgoingTransfer {
  meta: BlobOpen;
  frames: Buffer[];
  /** Next chunk index to send. A resume (or reconnect) rewinds this to the
   * receiver's persisted cursor. */
  cursor: number;
  /** Single-flight guard: a resume that arrives during an active pump just moves
   * the cursor; it does not start a second, interleaving pump. */
  pumping: boolean;
  resolve(): void;
  reject(error: unknown): void;
  settled: boolean;
}

export class BlobCoordinator {
  private readonly receiver: BlobReceiver;
  private io: BlobWireIO;
  private readonly maxInFlightBytes: number;
  private readonly outgoing = new Map<string, OutgoingTransfer>();
  private readonly completed = new Set<string>();
  private readonly completionWaiters = new Map<string, Array<() => void>>();
  private inFlightBytes = 0;

  constructor(sessionRoot: string, io: BlobWireIO, maxInFlightBytes = 8 * 1024 * 1024) {
    this.receiver = new BlobReceiver(sessionRoot);
    this.io = io;
    this.maxInFlightBytes = maxInFlightBytes;
  }

  /** Swap the transport after a reconnect and re-announce any pending outgoing
   * blob so the receiver replies with its persisted resume cursor. */
  async rebind(io: BlobWireIO): Promise<void> {
    this.io = io;
    for (const transfer of this.outgoing.values()) {
      if (!transfer.settled) {
        // Re-announce; the receiver's blob.accepted reply carries the authoritative
        // resume cursor, which the pump adopts.
        await this.io.sendBlobOpen(this.openMessage(transfer.meta));
      }
    }
  }

  /** Bytes counted against the negotiated in-flight window (blob chunk bytes
   * count toward `maxInFlightBytes`). */
  get inFlight(): number {
    return this.inFlightBytes;
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
    const transfer: OutgoingTransfer = { meta, frames, cursor: 0, pumping: false, resolve, reject, settled: false };
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

  /** Handle a `blob.accepted` reply for a blob this side is sending. */
  async onBlobAccepted(message: BlobAcceptedMessage): Promise<void> {
    const transfer = this.outgoing.get(message.blobId.toLowerCase());
    if (!transfer || transfer.settled) return;
    if (message.complete) {
      transfer.settled = true;
      this.outgoing.delete(transfer.meta.blobId);
      transfer.resolve();
      return;
    }
    await this.pump(transfer, message.nextChunk);
  }

  /** Handle a `blob.rejected` reply for a blob this side is sending. */
  onBlobRejected(message: BlobRejectedMessage): void {
    const transfer = this.outgoing.get(message.blobId.toLowerCase());
    if (!transfer || transfer.settled) return;
    transfer.settled = true;
    this.outgoing.delete(transfer.meta.blobId);
    transfer.reject(new BlobProtocolViolation(`peer rejected blob ${transfer.meta.blobId}: ${message.reason}`));
  }

  /** Handle an incoming `blob.open`: open (or resume) the durable receiver and
   * reply with the resume cursor, or `complete` if it was already received. */
  async onBlobOpen(message: BlobOpenMessage): Promise<void> {
    const meta = validateBlobOpen(message);
    if (await this.finalExists(meta.blobId)) {
      this.completed.add(meta.blobId);
      this.resolveCompletion(meta.blobId);
      await this.io.sendBlobAccepted({ blobId: meta.blobId, nextChunk: 0, complete: true });
      return;
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
      const reason = error instanceof Error ? error.message : "blob chunk rejected";
      await this.io.sendBlobRejected({ blobId: chunk.blobId, reason });
      throw new BlobProtocolViolation(reason);
    }
    this.inFlightBytes += chunk.data.length;
    if (accept.completed) {
      this.inFlightBytes = Math.max(0, this.inFlightBytes - chunk.data.length);
      this.completed.add(chunk.blobId);
      await this.io.sendBlobAccepted({ blobId: chunk.blobId, nextChunk: accept.nextChunk, complete: true });
      this.resolveCompletion(chunk.blobId);
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

  private async pump(transfer: OutgoingTransfer, fromChunk: number): Promise<void> {
    // Rewind to the receiver's authoritative cursor. A pump already in flight
    // observes this and continues from it; otherwise start one here. This keeps
    // exactly one pump per transfer so a reconnect never interleaves chunks.
    transfer.cursor = fromChunk;
    if (transfer.pumping) return;
    transfer.pumping = true;
    try {
      while (!transfer.settled && transfer.cursor < transfer.frames.length) {
        const i = transfer.cursor;
        await this.io.sendBinary(transfer.frames[i]);
        // Only advance if a concurrent resume did not rewind the cursor.
        if (transfer.cursor === i) transfer.cursor = i + 1;
      }
    } finally {
      transfer.pumping = false;
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
