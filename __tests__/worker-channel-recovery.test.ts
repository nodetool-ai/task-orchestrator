// __tests__/worker-channel-recovery.test.ts
//
// Plan section 17 (reliability and reaper integration). Nine recovery scenarios
// exercise the control-plane side of a worker WebSocket channel surviving
// disruption: control-plane restart, worker restart with a durable spool,
// provider death, the disconnect grace, stale-channel detection, protocol
// mismatch, terminal drain, stranded-input redispatch, and two replicas racing
// for one run's controller lease.
//
// The harness is the real Unix-socket supervisor (WorkerSession over ws), the
// same one worker-channel-controller.test.ts drives — no run driver.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db";
import { agentSessions, runnerInstances, workerChannelCommands } from "../db/schema";
import { create } from "../lib/runs";
import * as runDispatch from "../lib/run-dispatch";
import { provisionLocalChannel } from "../lib/run-dispatch";
import {
  acquireControllerLease,
  getChannelIdentity,
  getLastAcceptedWorkerSeq,
  touchChannel,
} from "../lib/worker-channel/repository";
import {
  connectRun,
  disconnectRun,
  reapStaleChannels,
  reconnectActiveChannels,
  sendCommand,
  shutdownAll,
} from "../lib/worker-channel/controller";
import {
  __resetReconnectTimingForTests,
  __setReconnectTimingForTests,
  getConnection,
} from "../lib/worker-channel/registry";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";

const SECRET = "channel-recovery-secret";

let servers: WorkerServer[] = [];
let roots: string[] = [];
let runIds: number[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-channel-recovery-"));
  roots.push(root);
  return root;
}

async function bootServer(
  runId: number,
  instanceId: string,
  listenEndpoint: string,
  outboxRoot: string,
  extra: Record<string, unknown> = {},
): Promise<WorkerServer> {
  const server = await startWorkerServer({
    runId,
    instanceId,
    endpoint: listenEndpoint,
    outboxRoot,
    ...extra,
  });
  servers.push(server);
  return server;
}

/** A run with a provisioned local channel, in the given non-terminal status. */
async function provisionRun(status: string, goal = "<implement>") {
  const run = await create({ goal, defer: true });
  runIds.push(run.id);
  const channel = await provisionLocalChannel(run.id);
  await db
    .update(agentSessions)
    .set({ status, workerScope: `scope-${run.id}`, workerPid: 4242, heartbeatAt: new Date() })
    .where(eq(agentSessions.id, run.id));
  return { runId: run.id, channel };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met within timeout");
}

async function commandRows(runId: number, type: string) {
  return db
    .select({ state: workerChannelCommands.state })
    .from(workerChannelCommands)
    .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, type)));
}

beforeEach(() => {
  process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = SECRET;
  // A short grace/backoff keeps the 60s production window from stalling the run.
  __setReconnectTimingForTests({ graceMs: 1500, backoffMs: 40 });
});

afterEach(async () => {
  for (const id of runIds) await disconnectRun(id).catch(() => undefined);
  await shutdownAll().catch(() => undefined);
  for (const server of servers) await server.close().catch(() => undefined);
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await db.delete(agentSessions).catch(() => undefined);
  servers = [];
  roots = [];
  runIds = [];
  vi.restoreAllMocks();
  __resetReconnectTimingForTests();
  delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
});

describe("worker channel recovery (plan section 17)", () => {
  it("control-plane restart re-adopts active channels and reconnects", async () => {
    const { runId, channel } = await provisionRun("running");
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());

    // A cold process has no in-memory connections: the boot scan re-adopts every
    // active channel from its stored endpoint.
    const reconnected = await reconnectActiveChannels();
    expect(reconnected).toBeGreaterThanOrEqual(1);
    expect(getConnection(runId)?.connected).toBe(true);

    // The re-adopted channel delivers commands.
    await sendCommand(runId, "run.cancel", { reason: "stop", requestId: "r", deadline: null });
    await waitFor(async () => (await commandRows(runId, "run.cancel")).every((r) => r.state === "acked"));
  });

  it("worker restart resumes the durable spool with a monotonic worker sequence", async () => {
    const { runId, channel } = await provisionRun("running");
    const root = await newRoot();
    let server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);
    await connectRun(runId);

    const first = await server.emit("run.phase", { phase: "running" });
    expect(first.seq).toBe(1);
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId, channel.instanceId)) >= 1);

    // The worker process dies and restarts against the SAME durable spool root.
    await disconnectRun(runId);
    await server.close();

    server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);
    await connectRun(runId);
    // Sequence continues from the persisted state — the restart does not reset it.
    const second = await server.emit("run.phase", { phase: "running" });
    expect(second.seq).toBe(2);
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId, channel.instanceId)) >= 2);
  });

  it("provider death lets the heartbeat reaper apply the existing policy", async () => {
    const { runId, channel } = await provisionRun("running", "<chat>");
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());
    await connectRun(runId);

    // The provider dies: close the worker and let the reconnect grace lapse.
    await server.close();
    await waitFor(() => getConnection(runId) === undefined, 4000);

    // Channel activity stopped bumping the heartbeat; simulate the stale window
    // having elapsed and run the shared orphan reaper. A chat run goes idle.
    await db
      .update(agentSessions)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(agentSessions.id, runId));
    const { reconcileOrphanedRuns } = await import("../lib/runs");
    await reconcileOrphanedRuns();
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0].status).toBe("idle");
  });

  it("disconnect grace reconnects a provider-live worker whose socket dropped", async () => {
    const { runId, channel } = await provisionRun("running");
    const root = await newRoot();
    let server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);
    await connectRun(runId);
    expect(getConnection(runId)?.connected).toBe(true);

    // Drop the socket but keep the provider alive: the worker's listener restarts
    // on the same endpoint. The supervisor reconnects within the grace window.
    await server.close();
    server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);

    await waitFor(() => getConnection(runId)?.connected === true, 4000);
    await sendCommand(runId, "run.cancel", { reason: "post-reconnect", requestId: "r2", deadline: null });
    await waitFor(async () => (await commandRows(runId, "run.cancel")).every((r) => r.state === "acked"));
  });

  it("stale-channel detection reconnects a supervisor-less silent channel", async () => {
    const { runId, channel } = await provisionRun("running");
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());
    // No connectRun: no in-memory supervisor. Backdate channel_last_seen_at so the
    // channel reads as stale off its own liveness clock.
    await db
      .update(runnerInstances)
      .set({ channelLastSeenAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(runnerInstances.runId, runId));

    const recovered = await reapStaleChannels();
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(getConnection(runId)?.connected).toBe(true);
  });

  it("protocol mismatch replaces the worker with the current image", async () => {
    const { runId, channel } = await provisionRun("running");
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot(), {
      helloProtocol: { min: 2, max: 2 },
    });
    const dispatchSpy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);

    await expect(connectRun(runId)).rejects.toThrow();

    // The incompatible instance is abandoned (its channel identity cleared) and a
    // fresh worker is dispatched from the current image.
    await waitFor(async () => (await getChannelIdentity(runId)) === null);
    expect(dispatchSpy).toHaveBeenCalledWith(runId);
  });

  it("intentional shutdown drains; a hot deploy just closes the socket", async () => {
    // Drain: the control plane tells the worker to finalize and exit.
    const drainRun = await provisionRun("running");
    await bootServer(drainRun.runId, drainRun.channel.instanceId, drainRun.channel.listenEndpoint, await newRoot());
    await connectRun(drainRun.runId);
    await shutdownAll({ drain: true });
    expect((await commandRows(drainRun.runId, "channel.drain")).length).toBeGreaterThanOrEqual(1);
    expect(getConnection(drainRun.runId)).toBeUndefined();

    // Hot deploy: no drain command; the worker keeps running for the next process.
    const hotRun = await provisionRun("running");
    await bootServer(hotRun.runId, hotRun.channel.instanceId, hotRun.channel.listenEndpoint, await newRoot());
    await connectRun(hotRun.runId);
    await shutdownAll();
    expect((await commandRows(hotRun.runId, "channel.drain")).length).toBe(0);
    expect(getConnection(hotRun.runId)).toBeUndefined();
  });

  it("a terminal commit clears the worker claim and controller lease", async () => {
    const { runId, channel } = await provisionRun("running");
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());
    await connectRun(runId);

    // The worker reports completion; the control plane lands terminal, commits,
    // then tears the channel down and clears the claim + lease.
    await server.emit("run.finished", { result: { ok: true } });
    await waitFor(async () => {
      const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0];
      return row.status === "completed" && row.workerScope === null;
    });
    await waitFor(async () => {
      const inst = (await db.select().from(runnerInstances).where(eq(runnerInstances.runId, runId)))[0];
      return inst.controllerId === null && inst.controllerLeaseExpiresAt === null;
    });
  });

  it("stranded input re-dispatches a non-terminal run after its claim releases", async () => {
    // A chat run parked idle with its worker claim released and a follow-up
    // message stranded: the existing dispatch semantics re-claim and re-spawn.
    const run = await create({ goal: "<chat>", defer: true });
    runIds.push(run.id);
    await db
      .update(agentSessions)
      .set({ status: "idle", workerScope: null, workerPid: null })
      .where(eq(agentSessions.id, run.id));
    await db.insert((await import("../db/schema")).agentMessages).values({
      runId: run.id,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "follow-up" }]),
      createdAt: new Date(),
    });

    const result = await runDispatch.dispatchRun(run.id, {
      spawn: () => 999,
      admit: () => "admit",
    });
    // Re-dispatched, not rejected: the released idle run is re-claimed and served
    // (a worker spawn, or the in-process server-resume path for this runtime).
    expect(["spawned", "server-resumed"]).toContain(result);
  });

  it("two replicas racing fence each other by controller epoch", async () => {
    const { runId, channel } = await provisionRun("running");
    const a = await acquireControllerLease(runId, "replica-a", new Date("2026-07-16T00:00:00Z"));
    const b = await acquireControllerLease(runId, "replica-b", new Date("2026-07-16T00:01:00Z"));
    expect(b.epoch).toBeGreaterThan(a.epoch);

    // The fenced replica's channel touch is rejected; the current one wins and its
    // touch also advances the shared heartbeat.
    expect(await touchChannel(runId, channel.instanceId, "replica-a", a.epoch, new Date("2026-07-16T00:01:05Z"))).toBe(false);
    expect(await touchChannel(runId, channel.instanceId, "replica-b", b.epoch, new Date("2026-07-16T00:01:05Z"))).toBe(true);
  });
});
