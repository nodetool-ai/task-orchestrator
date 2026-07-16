import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentMessages, agentSessions } from "../db/schema";
import { create } from "../lib/runs";
import { connectRun, disconnectRun, sendCommand, shutdownAll } from "../lib/worker-channel/controller";
import { getLastAcceptedWorkerSeq } from "../lib/worker-channel/repository";
import { provisionLocalChannel } from "../lib/run-dispatch";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import type { WorkerSession } from "../lib/worker-channel/worker-session";
import type { ControllerConnection } from "../lib/worker-channel/connection";
import type { BlobRef } from "../lib/worker-channel/protocol";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function blobRef(data: Buffer, blobId = randomUUID(), overrides: Partial<BlobRef> = {}): BlobRef {
  return {
    type: "blob",
    blobId,
    mimeType: "image/png",
    size: data.length,
    sha256: sha256(data),
    purpose: "attachment",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met within timeout");
}

function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol("pending");
  return Promise.race([promise.then(() => false, () => false), Promise.resolve(marker).then(() => true)]).then(
    (v) => v === true,
  );
}

describe("worker-channel blob wire integration", () => {
  let server: WorkerServer | undefined;
  let root: string | undefined;
  let runId: number | undefined;
  const blobRoots: string[] = [];

  beforeEach(async () => {
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "blob-wire-secret";
    await db.delete(agentSessions);
  });

  afterEach(async () => {
    if (runId != null) await disconnectRun(runId).catch(() => undefined);
    await shutdownAll().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await Promise.all(blobRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    server = undefined;
    root = undefined;
    runId = undefined;
    delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
  });

  async function boot(): Promise<{ connection: ControllerConnection; session: WorkerSession; instanceId: string }> {
    const run = await create({ goal: "<chat>", defer: true });
    runId = run.id;
    root = await mkdtemp(join(tmpdir(), "worker-channel-blob-wire-"));
    const channel = await provisionLocalChannel(run.id);
    blobRoots.push(join(tmpdir(), "task-orchestrator", "channel-blobs", `${run.id}-${channel.instanceId}`));
    server = await startWorkerServer({
      runId: run.id,
      instanceId: channel.instanceId,
      endpoint: channel.listenEndpoint,
      outboxRoot: root,
    });
    const connection = await connectRun(run.id);
    return {
      connection,
      session: server.session as unknown as WorkerSession,
      instanceId: channel.instanceId,
    };
  }

  it("round-trips a worker→control image blob then persists a referencing transcript.append", async () => {
    const { connection, session } = await boot();
    const image = Buffer.from("PNGDATA-".repeat(4096)); // ~32 KiB, one chunk boundary
    const ref = blobRef(image);

    // Sender completes the blob before referencing it (ordering rule).
    await session.sendBlob(ref, image);

    // The verified blob is on the control-plane's durable store.
    const stored = await readFile(connection.blobPath(ref.blobId));
    expect(stored.equals(image)).toBe(true);

    // The referencing transcript.append is accepted and persisted.
    await session.emit("transcript.append", {
      message: { id: 1, role: "agent", content: [ref] },
    });
    await waitFor(async () => {
      const rows = await db
        .select({ content: agentMessages.content })
        .from(agentMessages)
        .where(eq(agentMessages.runId, runId!));
      return rows.some((r) => String(r.content).includes(ref.blobId));
    });
  });

  it("defers run.ready until control→worker start-attachment blobs complete", async () => {
    const { connection, session } = await boot();
    const image = Buffer.from("ATTACH-".repeat(20000)); // multi-chunk
    const ref = blobRef(image);

    const startPayload = {
      mode: "start",
      run: { id: runId },
      task: null,
      plan: null,
      persona: { id: "implementor" },
      repository: { id: "repo" },
      transcript: [{ id: 1, role: "user", content: [ref] }],
      inboxDigest: null,
      memoryContext: "",
      pendingInput: [],
      policy: { allowedTools: [], maxTurns: null, deadline: null },
    };

    // run.start references an attachment blob that has NOT been transferred yet.
    await sendCommand(runId!, "run.start", startPayload);
    const startPromise = session.waitForStart();
    expect(await isPending(startPromise)).toBe(true);

    // Streaming the attachment to completion releases the deferred start.
    await connection.sendBlob(ref, image);
    await expect(startPromise).resolves.toMatchObject({ mode: "start" });
  });

  it("resumes a worker→control blob across a control-plane reconnect", async () => {
    const { session, instanceId } = await boot();
    const image = Buffer.alloc(2 * 1024 * 1024, 7); // ~32 chunks — slow enough to interrupt
    const ref = blobRef(image);

    const sending = session.sendBlob(ref, image);
    // Interrupt only once blob.open has a durable receipt: that guarantees the
    // reconnect cursor excludes it, so resume is driven by the sender re-opening
    // the blob rather than a stale-epoch replay of the original event.
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId!, instanceId)) >= 1);
    await disconnectRun(runId!);
    const reconnected = await connectRun(runId!);

    await expect(sending).resolves.toBeUndefined();
    const stored = await readFile(reconnected.blobPath(ref.blobId));
    expect(stored.equals(image)).toBe(true);
  }, 20000);

  it("rejects a worker→control blob whose bytes do not match the declared digest", async () => {
    const { session } = await boot();
    const real = Buffer.from("the-actual-bytes-transferred");
    // Declare a digest for different content: the receiver verifies and rejects.
    const ref = blobRef(real, randomUUID(), { sha256: sha256(Buffer.from("different-bytes")) });

    await expect(session.sendBlob(ref, real)).rejects.toThrow();
  });

  it("treats a reference to an incomplete blob as a protocol violation", async () => {
    const { connection, session } = await boot();
    const ref = blobRef(Buffer.from("never-sent"));

    // Emit a transcript.append that references a blob that was never transferred.
    await session.emit("transcript.append", {
      message: { id: 1, role: "agent", content: [ref] },
    });

    // The control plane closes the channel on the ordering-rule violation.
    await waitFor(() => !connection.connected);
  });
});
