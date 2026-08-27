import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions, runnerInstances, workerChannelCommands } from "../db/schema";
import { create } from "../lib/runs";
import {
  acquireControllerLease,
  getLastAcceptedWorkerSeq,
  persistCommand,
  rebasePendingCommands,
} from "../lib/worker-channel/repository";
import {
  connectRun,
  disconnectRun,
  sendCommand,
  shutdownAll,
} from "../lib/worker-channel/controller";
import { provisionLocalChannel } from "../lib/run-dispatch";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { __setLocalProcessForTests } from "../lib/runner/local";

const instanceId = "wi_0123456789abcdef0123456789abcdef";

describe("worker channel controller persistence", () => {
  beforeEach(async () => { await db.delete(agentSessions); });

  it("bumps the epoch for the same controller when asked (fresh worker generation)", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.insert(runnerInstances).values({ runId: run.id, provider: "local", state: "starting", channelInstanceId: "wi_ffffffffffffffffffffffffffffffff", channelEndpoint: "ws+unix:///tmp/x:/worker/channel" });
    const first = await acquireControllerLease(run.id, "same", new Date("2026-08-27T00:00:00Z"));
    const again = await acquireControllerLease(run.id, "same", new Date("2026-08-27T00:00:01Z"));
    const bumped = await acquireControllerLease(run.id, "same", new Date("2026-08-27T00:00:02Z"), { bump: true });
    expect(again.epoch).toBe(first.epoch);
    expect(bumped.epoch).toBe(first.epoch + 1);
  });

  it("fences controllers and replays persisted commands in the new epoch", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.insert(runnerInstances).values({ runId: run.id, channelInstanceId: instanceId, channelEndpoint: "ws://127.0.0.1:8787/worker/channel" });
    const first = await acquireControllerLease(run.id, "a", new Date("2026-07-16T00:00:00Z"));
    await persistCommand({ runId: run.id, instanceId, controllerEpoch: first.epoch, type: "run.cancel", payload: { reason: "test", requestId: "r", deadline: null } });
    const second = await acquireControllerLease(run.id, "b", new Date("2026-07-16T00:01:00Z"));
    const replay = await rebasePendingCommands(run.id, instanceId, second.epoch);
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ controllerEpoch: second.epoch, seq: 1, type: "run.cancel" });
  });
});

// Thin end-to-end channel harness (plan section 10.2): a locally provisioned
// supervisor (real WorkerSession over a Unix socket) accepts connectRun,
// receives a persisted command, emits an event that lands a receipt, and
// replays a persisted command across a controller reconnect — no run driver.
describe("local worker channel end-to-end (no driver)", () => {
  let server: WorkerServer | undefined;
  let root: string | undefined;
  let runId: number | undefined;

  beforeEach(async () => {
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "channel-e2e-secret";
    await db.delete(agentSessions);
  });

  afterEach(async () => {
    if (runId != null) await disconnectRun(runId).catch(() => undefined);
    await shutdownAll().catch(() => undefined);
    await server?.close().catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    server = undefined;
    root = undefined;
    runId = undefined;
    delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
  });

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("condition not met within timeout");
  }

  async function commandAcked(id: number, type: string): Promise<boolean> {
    const rows = await db
      .select({ state: workerChannelCommands.state })
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, id), eq(workerChannelCommands.type, type)));
    return rows.length > 0 && rows.every((r) => r.state === "acked");
  }

  it("dispatch -> connectRun -> command -> receipt -> reconnect replay", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    runId = run.id;
    root = await mkdtemp(join(tmpdir(), "worker-channel-e2e-"));

    // "Dispatch": reserve the local channel identity + endpoints and boot the
    // real supervisor bound to the same Unix socket.
    const channel = await provisionLocalChannel(run.id);
    await db.update(agentSessions).set({ workerScope: "hello-worker" }).where(eq(agentSessions.id, run.id));
    __setLocalProcessForTests("hello-worker", { pid: process.pid, spawnedAt: "2026-08-27T10:00:00.000Z" });
    server = await startWorkerServer({
      runId: run.id,
      instanceId: channel.instanceId,
      endpoint: channel.listenEndpoint,
      outboxRoot: root,
    });

    // Control plane dials the stored ws+unix endpoint and completes the handshake.
    const connection = await connectRun(run.id);
    expect(connection.connected).toBe(true);
    const [instance] = await db.select({ workerIncarnation: runnerInstances.workerIncarnation }).from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(instance.workerIncarnation).toBe(`${process.pid}#2026-08-27T10:00:00.000Z`);

    // A persisted command is delivered and cumulatively acked by the worker.
    await sendCommand(run.id, "run.cancel", { reason: "stop", requestId: "req-1", deadline: null });
    expect(await commandAcked(run.id, "run.cancel")).toBe(true);

    // The worker emits an event; the controller lands a durable receipt.
    await server.emit("run.phase", { phase: "running" });
    await waitFor(async () => (await getLastAcceptedWorkerSeq(run.id, channel.instanceId)) >= 1);

    // Reconnect: a command persisted while the controller is down replays on
    // the next connect (rebased into the fresh epoch).
    await disconnectRun(run.id);
    await persistCommand({
      runId: run.id,
      instanceId: channel.instanceId,
      controllerEpoch: connection.controllerEpoch,
      type: "run.park",
      payload: { reason: "reconnect-me" },
    });
    expect(await commandAcked(run.id, "run.park")).toBe(false); // not delivered yet

    await connectRun(run.id);
    await waitFor(() => commandAcked(run.id, "run.park"));
  });
});
