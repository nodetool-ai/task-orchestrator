import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BLOB_CHUNK_BYTES,
  BlobReceiver,
  chunkBlob,
} from "../lib/worker-channel/blob";
import { BlobCoordinator } from "../lib/worker-channel/blob-transfer";
import type {
  BlobAcceptedMessage,
  BlobOpenMessage,
  BlobRef,
  BlobRejectedMessage,
} from "../lib/worker-channel/protocol";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function ref(data: Buffer, blobId = randomUUID()): Omit<BlobRef, "type"> {
  return { blobId, mimeType: "image/png", size: data.length, sha256: sha256(data), purpose: "attachment" };
}

function openMessage(data: Buffer, blobId: string): BlobOpenMessage {
  return { blobId, size: data.length, sha256: sha256(data), mimeType: "image/png", purpose: "attachment" };
}

/** Fake wire seam capturing everything a coordinator emits. `sendBinary` is
 * async and resolves on the microtask queue so a detached pump makes progress. */
function fakeIo() {
  const opens: BlobOpenMessage[] = [];
  const accepted: BlobAcceptedMessage[] = [];
  const rejected: BlobRejectedMessage[] = [];
  const binaries: Buffer[] = [];
  return {
    opens,
    accepted,
    rejected,
    binaries,
    io: {
      sendBlobOpen: (m: BlobOpenMessage) => {
        opens.push(m);
      },
      sendBlobAccepted: (m: BlobAcceptedMessage) => {
        accepted.push(m);
      },
      sendBlobRejected: (m: BlobRejectedMessage) => {
        rejected.push(m);
      },
      sendBinary: async (frame: Buffer) => {
        binaries.push(Buffer.from(frame));
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met within timeout");
}

/** Let the detached pump drain until it parks, then confirm it stays put. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("BlobCoordinator send-side backpressure", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "blob-coord-send-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("caps in-flight bytes against a peer that never acks and resumes when the budget frees", async () => {
    const budget = 2 * BLOB_CHUNK_BYTES;
    const wire = fakeIo();
    const coordinator = new BlobCoordinator(root, wire.io, budget);

    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 6, 7); // 6 full chunks
    const blobId = randomUUID();
    const done = coordinator.sendBlob(ref(data, blobId), data);

    // Nothing streams until the peer replies to blob.open with the resume cursor.
    expect(wire.opens).toHaveLength(1);
    expect(wire.binaries).toHaveLength(0);

    // Open reply (nextChunk 0): the pump starts, sends two chunks, then parks —
    // a third would push the in-flight set past the 2-chunk window.
    coordinator.onBlobAccepted({ blobId, nextChunk: 0, complete: false });
    await waitFor(() => wire.binaries.length === 2);
    await settle();
    expect(wire.binaries).toHaveLength(2); // stays parked without further acks
    expect(coordinator.inFlight).toBe(budget);
    expect(coordinator.inFlight).toBeLessThanOrEqual(budget);

    // A window ack retiring the first two chunks releases the budget: two more flow.
    coordinator.onBlobAccepted({ blobId, nextChunk: 2, complete: false });
    await waitFor(() => wire.binaries.length === 4);
    await settle();
    expect(wire.binaries).toHaveLength(4);
    expect(coordinator.inFlight).toBe(budget);

    // Final window ack drains the rest; the whole blob is now on the wire.
    coordinator.onBlobAccepted({ blobId, nextChunk: 4, complete: false });
    await waitFor(() => wire.binaries.length === 6);

    // Completion resolves the send.
    coordinator.onBlobAccepted({ blobId, nextChunk: 6, complete: true });
    await expect(done).resolves.toBeUndefined();
    expect(coordinator.inFlight).toBe(0);
  });
});

describe("BlobCoordinator incoming concurrency cap", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "blob-coord-recv-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects opens beyond the concurrent-transfer limit without spooling a .part", async () => {
    const wire = fakeIo();
    const coordinator = new BlobCoordinator(root, wire.io, 8 * 1024 * 1024, 2);

    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    const payload = Buffer.alloc(BLOB_CHUNK_BYTES, 1);

    await coordinator.onBlobOpen(openMessage(payload, a));
    await coordinator.onBlobOpen(openMessage(payload, b));
    // Third distinct transfer exceeds the cap of 2.
    await coordinator.onBlobOpen(openMessage(payload, c));

    expect(wire.accepted.map((m) => m.blobId)).toEqual([a, b]);
    expect(wire.rejected).toHaveLength(1);
    expect(wire.rejected[0].blobId).toBe(c);
    expect(wire.rejected[0].reason).toMatch(/too many concurrent/i);

    // The refused transfer never created a .part file.
    const partC = join(root, "channel", "blobs", `${c}.part`);
    await expect(access(partC)).rejects.toThrow();

    // Re-opening a tracked transfer (reconnect resume) reuses its slot.
    await coordinator.onBlobOpen(openMessage(payload, a));
    expect(wire.rejected).toHaveLength(1);
  });
});

describe("BlobCoordinator receive-side window-ack accounting", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "blob-coord-acct-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("emits window acks on a running byte tally and never over-acks a duplicate", async () => {
    const wire = fakeIo();
    // Threshold = maxInFlightBytes / 2 = 2 chunks.
    const coordinator = new BlobCoordinator(root, wire.io, 4 * BLOB_CHUNK_BYTES);

    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 5, 3); // 5 full chunks
    const blobId = randomUUID();
    const frames = chunkBlob(blobId, data);

    await coordinator.onBlobOpen(openMessage(data, blobId));
    // Open reply.
    expect(wire.accepted).toEqual([{ blobId, nextChunk: 0, complete: false }]);

    for (const frame of frames) await coordinator.onBinary(frame);

    // After chunk 1 (128 KiB tally) and chunk 3 the receiver echoes window acks;
    // the final chunk completes. The tally resets after each ack, so exactly two
    // interim acks appear — no per-chunk flood, no drift.
    expect(wire.accepted).toEqual([
      { blobId, nextChunk: 0, complete: false },
      { blobId, nextChunk: 2, complete: false },
      { blobId, nextChunk: 4, complete: false },
      { blobId, nextChunk: 5, complete: true },
    ]);
    expect(coordinator.isComplete(blobId)).toBe(true);

    // The verified blob landed in the durable store.
    const receiver = new BlobReceiver(root);
    await expect(access(receiver.finalPathFor(blobId))).resolves.toBeUndefined();

    // A redelivered final chunk after completion is idempotent and produces no
    // further ack (the incoming accounting was cleaned up on completion).
    await coordinator.onBinary(frames[frames.length - 1]);
    expect(wire.accepted).toHaveLength(4);
  });
});
