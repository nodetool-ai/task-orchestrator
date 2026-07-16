import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

/**
 * Blob transfer per docs/worker-websocket-protocol.md "Blob transfer".
 *
 * The sender first sends a `blob.open` JSON message with
 * `{blobId, size, sha256, mimeType, purpose}`, then binary frames shaped:
 *
 *   byte 0       protocol major
 *   byte 1       flags (bit 0 = final chunk)
 *   bytes 2..17  raw 128-bit blob id
 *   bytes 18..21 chunk number, unsigned big-endian
 *   bytes 22..   data
 *
 * This module implements the header codec, chunking, and a resumable,
 * durable receiver used by both worker and control plane. It never places
 * base64 blob bytes in JSON or logs.
 */

export const BLOB_PROTOCOL_MAJOR = 1 as const;
export const BLOB_CHUNK_BYTES = 64 * 1024;
export const BLOB_MAX_SIZE_BYTES = 25 * 1024 * 1024;
export const BLOB_HEADER_BYTES = 22;

const FINAL_FLAG = 0b0000_0001;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const MIME_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

const BLOBS_DIR = ["channel", "blobs"] as const;
const PART_SUFFIX = ".part";
const CURSOR_SUFFIX = ".cursor.json";

export const BLOB_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class BlobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobValidationError";
  }
}

/** Metadata carried by the JSON `blob.open` message. */
export interface BlobOpen {
  blobId: string;
  size: number;
  sha256: string;
  mimeType: string;
  purpose: string;
}

export function validateBlobOpen(value: unknown): BlobOpen {
  if (typeof value !== "object" || value === null) {
    throw new BlobValidationError("blob.open payload must be an object");
  }
  const v = value as Record<string, unknown>;

  if (typeof v.blobId !== "string" || !UUID_PATTERN.test(v.blobId)) {
    throw new BlobValidationError("blob.open blobId must be a UUID");
  }
  if (
    typeof v.size !== "number" ||
    !Number.isInteger(v.size) ||
    v.size < 0 ||
    v.size > BLOB_MAX_SIZE_BYTES
  ) {
    throw new BlobValidationError(
      `blob.open size must be an integer in 0..${BLOB_MAX_SIZE_BYTES}`
    );
  }
  if (typeof v.sha256 !== "string" || !SHA256_HEX_PATTERN.test(v.sha256)) {
    throw new BlobValidationError("blob.open sha256 must be 64 hex characters");
  }
  if (typeof v.mimeType !== "string" || !MIME_TYPE_PATTERN.test(v.mimeType)) {
    throw new BlobValidationError("blob.open mimeType is invalid");
  }
  if (typeof v.purpose !== "string" || v.purpose.length === 0 || v.purpose.length > 64) {
    throw new BlobValidationError("blob.open purpose must be a non-empty string");
  }

  return {
    blobId: v.blobId.toLowerCase(),
    size: v.size,
    sha256: v.sha256.toLowerCase(),
    mimeType: v.mimeType,
    purpose: v.purpose,
  };
}

/** Decoded contents of a binary blob chunk frame. */
export interface BlobChunkFrame {
  protocolMajor: number;
  final: boolean;
  blobId: string;
  chunkNumber: number;
  data: Buffer;
}

function blobIdToBytes(blobId: string): Buffer {
  if (!UUID_PATTERN.test(blobId)) {
    throw new BlobValidationError("blobId must be a UUID");
  }
  const hex = blobId.replace(/-/g, "");
  return Buffer.from(hex, "hex");
}

function bytesToBlobId(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Encode one binary blob chunk frame per the header layout above. */
export function encodeBlobChunk(params: {
  blobId: string;
  chunkNumber: number;
  final: boolean;
  data: Buffer;
}): Buffer {
  const { blobId, chunkNumber, final, data } = params;
  if (!Number.isInteger(chunkNumber) || chunkNumber < 0 || chunkNumber > 0xffffffff) {
    throw new BlobValidationError("chunkNumber must be a uint32");
  }
  if (data.length > BLOB_CHUNK_BYTES) {
    throw new BlobValidationError(
      `chunk data exceeds ${BLOB_CHUNK_BYTES} bytes`
    );
  }
  const header = Buffer.alloc(BLOB_HEADER_BYTES);
  header.writeUInt8(BLOB_PROTOCOL_MAJOR, 0);
  header.writeUInt8(final ? FINAL_FLAG : 0, 1);
  blobIdToBytes(blobId).copy(header, 2);
  header.writeUInt32BE(chunkNumber >>> 0, 18);
  return Buffer.concat([header, data]);
}

/** Decode one binary blob chunk frame. */
export function decodeBlobChunk(frame: Buffer): BlobChunkFrame {
  if (frame.length < BLOB_HEADER_BYTES) {
    throw new BlobValidationError("blob chunk frame is shorter than the header");
  }
  const protocolMajor = frame.readUInt8(0);
  const flags = frame.readUInt8(1);
  const blobId = bytesToBlobId(frame.subarray(2, 18));
  const chunkNumber = frame.readUInt32BE(18);
  const data = frame.subarray(BLOB_HEADER_BYTES);
  return {
    protocolMajor,
    final: (flags & FINAL_FLAG) !== 0,
    blobId,
    chunkNumber,
    data: Buffer.from(data),
  };
}

/** Split a full in-memory buffer into binary chunk frames ready to send. */
export function chunkBlob(blobId: string, data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const totalChunks = Math.max(1, Math.ceil(data.length / BLOB_CHUNK_BYTES));
  for (let i = 0; i < totalChunks; i++) {
    const start = i * BLOB_CHUNK_BYTES;
    const end = Math.min(start + BLOB_CHUNK_BYTES, data.length);
    frames.push(
      encodeBlobChunk({
        blobId,
        chunkNumber: i,
        final: i === totalChunks - 1,
        data: data.subarray(start, end),
      })
    );
  }
  return frames;
}

interface BlobCursorState {
  version: 1;
  blobId: string;
  size: number;
  sha256: string;
  mimeType: string;
  purpose: string;
  nextChunk: number;
  bytesWritten: number;
  openedAt: string;
}

export interface BlobAccepted {
  blobId: string;
  path: string;
}

export interface BlobChunkAccept {
  /** Chunk cursor to resume from: the next chunk number expected. */
  nextChunk: number;
  /** Set once the final chunk has been written and verified. */
  completed: boolean;
}

function blobsDir(sessionRoot: string): string {
  return join(sessionRoot, ...BLOBS_DIR);
}

function partPath(sessionRoot: string, blobId: string): string {
  return join(blobsDir(sessionRoot), `${blobId}${PART_SUFFIX}`);
}

function cursorPath(sessionRoot: string, blobId: string): string {
  return join(blobsDir(sessionRoot), `${blobId}${CURSOR_SUFFIX}`);
}

async function fsyncFile(handle: FileHandle): Promise<void> {
  await handle.sync();
}

async function writeFileDurably(path: string, data: string | Buffer): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(data);
    await fsyncFile(handle);
  } finally {
    await handle.close();
  }
}

async function readCursor(sessionRoot: string, blobId: string): Promise<BlobCursorState | null> {
  try {
    const raw = await readFile(cursorPath(sessionRoot, blobId), "utf8");
    return JSON.parse(raw) as BlobCursorState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Durable, resumable receiver for one blob. Accepts chunks in order,
 * persists an accepted-chunk cursor after each write, and verifies the
 * declared SHA-256 before an atomic rename out of `.part`.
 */
export class BlobReceiver {
  constructor(private readonly sessionRoot: string) {}

  /** Begin (or resume) receiving a blob declared by `blob.open`. Returns the
   *  chunk number to resume sending from. */
  async open(meta: BlobOpen): Promise<{ resumeFromChunk: number }> {
    await mkdir(blobsDir(this.sessionRoot), { recursive: true, mode: 0o700 });

    const existing = await readCursor(this.sessionRoot, meta.blobId);
    if (existing) {
      if (
        existing.size !== meta.size ||
        existing.sha256 !== meta.sha256 ||
        existing.mimeType !== meta.mimeType ||
        existing.purpose !== meta.purpose
      ) {
        // Metadata changed: discard the stale partial and start over.
        await this.discard(meta.blobId);
      } else {
        return { resumeFromChunk: existing.nextChunk };
      }
    }

    const part = partPath(this.sessionRoot, meta.blobId);
    // Create (or truncate) the part file so a zero-byte blob has a file to
    // rename once its single final empty chunk arrives.
    const handle = await open(part, "w", 0o600);
    await handle.close();

    const cursor: BlobCursorState = {
      version: 1,
      blobId: meta.blobId,
      size: meta.size,
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      purpose: meta.purpose,
      nextChunk: 0,
      bytesWritten: 0,
      openedAt: new Date().toISOString(),
    };
    await writeFileDurably(cursorPath(this.sessionRoot, meta.blobId), JSON.stringify(cursor));
    return { resumeFromChunk: 0 };
  }

  /**
   * Apply one decoded chunk. Duplicate (already-accepted) chunks are
   * accepted idempotently and re-report the current cursor. A chunk that
   * skips ahead of the cursor is rejected as "missing chunk" — the sender
   * must resume from `nextChunk`.
   */
  async acceptChunk(chunk: BlobChunkFrame): Promise<BlobChunkAccept> {
    const cursor = await readCursor(this.sessionRoot, chunk.blobId);
    if (!cursor) {
      throw new BlobValidationError(`no open blob transfer for ${chunk.blobId}`);
    }

    if (chunk.chunkNumber < cursor.nextChunk) {
      // Duplicate of an already-accepted chunk: idempotent no-op.
      return { nextChunk: cursor.nextChunk, completed: false };
    }
    if (chunk.chunkNumber > cursor.nextChunk) {
      throw new BlobValidationError(
        `missing chunk: expected ${cursor.nextChunk}, got ${chunk.chunkNumber}`
      );
    }
    if (chunk.data.length > BLOB_CHUNK_BYTES) {
      throw new BlobValidationError(`chunk data exceeds ${BLOB_CHUNK_BYTES} bytes`);
    }

    const nextBytesWritten = cursor.bytesWritten + chunk.data.length;
    if (nextBytesWritten > cursor.size) {
      throw new BlobValidationError("blob transfer exceeds declared size");
    }

    const part = partPath(this.sessionRoot, chunk.blobId);
    const handle = await open(part, "r+", 0o600);
    try {
      if (chunk.data.length > 0) {
        await handle.write(chunk.data, 0, chunk.data.length, cursor.bytesWritten);
      }
      await fsyncFile(handle);
    } finally {
      await handle.close();
    }

    const updated: BlobCursorState = {
      ...cursor,
      nextChunk: cursor.nextChunk + 1,
      bytesWritten: nextBytesWritten,
    };
    await writeFileDurably(cursorPath(this.sessionRoot, chunk.blobId), JSON.stringify(updated));

    if (!chunk.final) {
      return { nextChunk: updated.nextChunk, completed: false };
    }

    if (updated.bytesWritten !== updated.size) {
      throw new BlobValidationError(
        `final chunk received but ${updated.bytesWritten} of ${updated.size} bytes written`
      );
    }

    await this.finalize(updated);
    return { nextChunk: updated.nextChunk, completed: true };
  }

  private async finalize(cursor: BlobCursorState): Promise<BlobAccepted> {
    const part = partPath(this.sessionRoot, cursor.blobId);
    const digest = await sha256File(part);
    if (digest !== cursor.sha256) {
      await this.discard(cursor.blobId);
      throw new BlobValidationError(
        `blob ${cursor.blobId} sha256 mismatch: expected ${cursor.sha256}, got ${digest}`
      );
    }

    const finalPath = join(blobsDir(this.sessionRoot), cursor.blobId);
    await rename(part, finalPath);
    // The cursor is intentionally kept (not deleted) so a redelivered final
    // chunk after completion is still recognized as an idempotent duplicate.
    // `discard` removes it explicitly on terminal drain / cleanup sweep.
    return { blobId: cursor.blobId, path: finalPath };
  }

  /** Path a completed blob was (or would be) renamed to. */
  finalPathFor(blobId: string): string {
    return join(blobsDir(this.sessionRoot), blobId);
  }

  /** Discard a partial (or completed) blob's on-disk state. Used on terminal
   *  drain and by the 24h cleanup sweep. */
  async discard(blobId: string): Promise<void> {
    await unlink(partPath(this.sessionRoot, blobId)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
    await unlink(cursorPath(this.sessionRoot, blobId)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Delete partial (`.part` + cursor) blobs older than `maxAgeMs`. Intended to
 * be run on terminal drain (with `maxAgeMs: 0`, i.e. delete all partials) and
 * periodically (with the 24h default) to reclaim orphaned transfers.
 */
export async function cleanupExpiredBlobParts(
  sessionRoot: string,
  maxAgeMs: number = BLOB_PART_MAX_AGE_MS
): Promise<string[]> {
  const dir = blobsDir(sessionRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const now = Date.now();
  const removed: string[] = [];
  const partFiles = entries.filter((name) => name.endsWith(PART_SUFFIX));

  for (const name of partFiles) {
    const blobId = name.slice(0, -PART_SUFFIX.length);
    const path = join(dir, name);
    let ageMs = 0;
    try {
      const info = await stat(path);
      ageMs = now - info.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (ageMs >= maxAgeMs) {
      await unlink(path).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      await unlink(cursorPath(sessionRoot, blobId)).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      removed.push(blobId);
    }
  }
  return removed;
}
