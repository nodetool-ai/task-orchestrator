import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BLOB_CHUNK_BYTES,
  BLOB_MAX_SIZE_BYTES,
  BLOB_HEADER_BYTES,
  BLOB_PROTOCOL_MAJOR,
  BlobReceiver,
  BlobValidationError,
  chunkBlob,
  cleanupExpiredBlobParts,
  decodeBlobChunk,
  encodeBlobChunk,
  validateBlobOpen,
  type BlobOpen,
} from "../lib/worker-channel/blob";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function openFor(blobId: string, data: Buffer, overrides: Partial<BlobOpen> = {}): BlobOpen {
  return {
    blobId,
    size: data.length,
    sha256: sha256(data),
    mimeType: "image/png",
    purpose: "attachment",
    ...overrides,
  };
}

describe("worker-channel/blob header codec", () => {
  it("round-trips a chunk header", () => {
    const blobId = randomUUID();
    const data = Buffer.from("hello world");
    const frame = encodeBlobChunk({ blobId, chunkNumber: 3, final: true, data });

    expect(frame.length).toBe(BLOB_HEADER_BYTES + data.length);
    expect(frame.readUInt8(0)).toBe(BLOB_PROTOCOL_MAJOR);

    const decoded = decodeBlobChunk(frame);
    expect(decoded.blobId).toBe(blobId.toLowerCase());
    expect(decoded.chunkNumber).toBe(3);
    expect(decoded.final).toBe(true);
    expect(decoded.data.equals(data)).toBe(true);
  });

  it("clears the final flag bit for non-final chunks", () => {
    const blobId = randomUUID();
    const frame = encodeBlobChunk({ blobId, chunkNumber: 0, final: false, data: Buffer.alloc(0) });
    const decoded = decodeBlobChunk(frame);
    expect(decoded.final).toBe(false);
  });

  it("rejects a chunk larger than 64 KiB", () => {
    const blobId = randomUUID();
    expect(() =>
      encodeBlobChunk({ blobId, chunkNumber: 0, final: true, data: Buffer.alloc(BLOB_CHUNK_BYTES + 1) })
    ).toThrow(BlobValidationError);
  });

  it("rejects a frame shorter than the header", () => {
    expect(() => decodeBlobChunk(Buffer.alloc(BLOB_HEADER_BYTES - 1))).toThrow(BlobValidationError);
  });
});

describe("worker-channel/blob validateBlobOpen", () => {
  it("accepts a well-formed declaration", () => {
    const blobId = randomUUID();
    const meta = validateBlobOpen(openFor(blobId, Buffer.from("x")));
    expect(meta.blobId).toBe(blobId.toLowerCase());
  });

  it("rejects a non-UUID blobId", () => {
    expect(() => validateBlobOpen(openFor("not-a-uuid", Buffer.from("x")))).toThrow(BlobValidationError);
  });

  it("rejects a size above 25 MiB", () => {
    const blobId = randomUUID();
    expect(() =>
      validateBlobOpen(openFor(blobId, Buffer.alloc(1), { size: BLOB_MAX_SIZE_BYTES + 1 }))
    ).toThrow(BlobValidationError);
  });

  it("rejects a negative size", () => {
    const blobId = randomUUID();
    expect(() => validateBlobOpen(openFor(blobId, Buffer.alloc(1), { size: -1 }))).toThrow(
      BlobValidationError
    );
  });

  it("accepts size exactly at the 25 MiB boundary", () => {
    const blobId = randomUUID();
    const meta = validateBlobOpen(openFor(blobId, Buffer.alloc(1), { size: BLOB_MAX_SIZE_BYTES }));
    expect(meta.size).toBe(BLOB_MAX_SIZE_BYTES);
  });

  it("rejects a malformed sha256", () => {
    const blobId = randomUUID();
    expect(() => validateBlobOpen(openFor(blobId, Buffer.alloc(1), { sha256: "nothex" }))).toThrow(
      BlobValidationError
    );
  });

  it("rejects a malformed mimeType", () => {
    const blobId = randomUUID();
    expect(() => validateBlobOpen(openFor(blobId, Buffer.alloc(1), { mimeType: "not a mime" }))).toThrow(
      BlobValidationError
    );
  });

  it("rejects an empty purpose", () => {
    const blobId = randomUUID();
    expect(() => validateBlobOpen(openFor(blobId, Buffer.alloc(1), { purpose: "" }))).toThrow(
      BlobValidationError
    );
  });
});

describe("worker-channel/blob chunkBlob", () => {
  it("produces exactly one final chunk for an empty blob", () => {
    const blobId = randomUUID();
    const frames = chunkBlob(blobId, Buffer.alloc(0));
    expect(frames).toHaveLength(1);
    const decoded = decodeBlobChunk(frames[0]);
    expect(decoded.final).toBe(true);
    expect(decoded.chunkNumber).toBe(0);
    expect(decoded.data.length).toBe(0);
  });

  it("produces one chunk for data under the chunk size", () => {
    const blobId = randomUUID();
    const data = Buffer.from("small payload");
    const frames = chunkBlob(blobId, data);
    expect(frames).toHaveLength(1);
    expect(decodeBlobChunk(frames[0]).final).toBe(true);
  });

  it("splits multi-chunk data with only the last chunk marked final", () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 100, 7);
    const frames = chunkBlob(blobId, data);
    expect(frames).toHaveLength(3);
    frames.forEach((frame, i) => {
      const decoded = decodeBlobChunk(frame);
      expect(decoded.chunkNumber).toBe(i);
      expect(decoded.final).toBe(i === frames.length - 1);
    });
  });

  it("chunks a full 25 MiB blob into exact-size pieces plus a remainder", () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_MAX_SIZE_BYTES, 9);
    const frames = chunkBlob(blobId, data);
    const expectedChunks = Math.ceil(BLOB_MAX_SIZE_BYTES / BLOB_CHUNK_BYTES);
    expect(frames).toHaveLength(expectedChunks);
    const reassembled = Buffer.concat(frames.map((f) => decodeBlobChunk(f).data));
    expect(reassembled.equals(data)).toBe(true);
  });
});

describe("worker-channel/blob BlobReceiver", () => {
  let sessionRoot: string;

  beforeEach(async () => {
    sessionRoot = await mkdtemp(join(tmpdir(), "worker-channel-blob-"));
  });

  afterEach(async () => {
    await rm(sessionRoot, { recursive: true, force: true });
  });

  it("receives an empty blob in one final chunk", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(0);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    const result = await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    expect(result.completed).toBe(true);
    const finalPath = receiver.finalPathFor(blobId);
    const written = await readFile(finalPath);
    expect(written.length).toBe(0);
  });

  it("receives a one-chunk blob", async () => {
    const blobId = randomUUID();
    const data = Buffer.from("a single chunk of bytes");
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    expect(frames).toHaveLength(1);
    const result = await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    expect(result.completed).toBe(true);
    const written = await readFile(receiver.finalPathFor(blobId));
    expect(written.equals(data)).toBe(true);
  });

  it("receives a multi-chunk blob", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 3 + 12345, 3);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    let last;
    for (const frame of frames) {
      last = await receiver.acceptChunk(decodeBlobChunk(frame));
    }

    expect(last?.completed).toBe(true);
    const written = await readFile(receiver.finalPathFor(blobId));
    expect(written.equals(data)).toBe(true);
  });

  it("receives a full 25 MiB blob", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_MAX_SIZE_BYTES, 5);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    let last;
    for (const frame of frames) {
      last = await receiver.acceptChunk(decodeBlobChunk(frame));
    }

    expect(last?.completed).toBe(true);
    const info = await stat(receiver.finalPathFor(blobId));
    expect(info.size).toBe(BLOB_MAX_SIZE_BYTES);
  }, 30_000);

  it("rejects an oversize declared blob before any bytes are accepted", async () => {
    const blobId = randomUUID();
    const receiver = new BlobReceiver(sessionRoot);
    expect(() =>
      validateBlobOpen(openFor(blobId, Buffer.alloc(1), { size: BLOB_MAX_SIZE_BYTES + 1 }))
    ).toThrow(BlobValidationError);
    void receiver; // no transfer was ever opened
  });

  it("rejects and discards on a wrong digest", async () => {
    const blobId = randomUUID();
    const data = Buffer.from("correct bytes");
    const meta = openFor(blobId, data, { sha256: sha256(Buffer.from("wrong bytes")) });
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    await expect(receiver.acceptChunk(decodeBlobChunk(frames[0]))).rejects.toThrow(BlobValidationError);

    await expect(readFile(receiver.finalPathFor(blobId))).rejects.toThrow();
  });

  it("rejects a chunk that skips ahead (missing chunk)", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 10, 1);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    // Skip chunk 0, go straight to chunk 1.
    await expect(receiver.acceptChunk(decodeBlobChunk(frames[1]))).rejects.toThrow(BlobValidationError);
  });

  it("accepts a duplicate chunk idempotently", async () => {
    const blobId = randomUUID();
    const data = Buffer.from("duplicate me");
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    const first = await receiver.acceptChunk(decodeBlobChunk(frames[0]));
    // Re-deliver the same (already-accepted) final chunk.
    const second = await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    expect(first.completed).toBe(true);
    expect(second.completed).toBe(false);
    expect(second.nextChunk).toBe(first.nextChunk);
    const written = await readFile(receiver.finalPathFor(blobId));
    expect(written.equals(data)).toBe(true);
  });

  it("resumes from the persisted cursor after a reconnect", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 3 + 500, 2);
    const meta = openFor(blobId, data);

    const receiverA = new BlobReceiver(sessionRoot);
    await receiverA.open(meta);
    const frames = chunkBlob(blobId, data);
    await receiverA.acceptChunk(decodeBlobChunk(frames[0]));
    await receiverA.acceptChunk(decodeBlobChunk(frames[1]));

    // Simulate a reconnect: a fresh receiver instance re-opens the same blob.
    const receiverB = new BlobReceiver(sessionRoot);
    const { resumeFromChunk } = await receiverB.open(meta);
    expect(resumeFromChunk).toBe(2);

    let last;
    for (let i = resumeFromChunk; i < frames.length; i++) {
      last = await receiverB.acceptChunk(decodeBlobChunk(frames[i]));
    }
    expect(last?.completed).toBe(true);
    const written = await readFile(receiverB.finalPathFor(blobId));
    expect(written.equals(data)).toBe(true);
  });

  it("discards partial blobs on terminal drain", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2, 4);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    await receiver.discard(blobId);

    const removedAgain = await cleanupExpiredBlobParts(sessionRoot, 0);
    expect(removedAgain).toEqual([]);
    await expect(readFile(receiver.finalPathFor(blobId))).rejects.toThrow();
  });

  it("sweeps partial blobs older than the max age", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2, 6);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    // Backdate the .part file's mtime by 25 hours so it is past the 24h window.
    const partFile = join(sessionRoot, "channel", "blobs", `${blobId}.part`);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(partFile, old, old);

    const removed = await cleanupExpiredBlobParts(sessionRoot);
    expect(removed).toEqual([blobId]);
    await expect(readFile(partFile)).rejects.toThrow();
  });

  it("does not sweep partial blobs younger than the max age", async () => {
    const blobId = randomUUID();
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2, 8);
    const meta = openFor(blobId, data);
    const receiver = new BlobReceiver(sessionRoot);

    await receiver.open(meta);
    const frames = chunkBlob(blobId, data);
    await receiver.acceptChunk(decodeBlobChunk(frames[0]));

    const removed = await cleanupExpiredBlobParts(sessionRoot);
    expect(removed).toEqual([]);
    const partFile = join(sessionRoot, "channel", "blobs", `${blobId}.part`);
    await expect(readFile(partFile)).resolves.toBeInstanceOf(Buffer);
  });
});
