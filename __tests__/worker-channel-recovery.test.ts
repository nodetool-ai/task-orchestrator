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
import WebSocket from "ws";
import { db } from "../db";
import { agentSessions, runnerInstances, workerChannelCommands } from "../db/schema";
import { create } from "../lib/runs";
import * as runDispatch from "../lib/run-dispatch";
import { provisionLocalChannel } from "../lib/run-dispatch";
import {
  acquireControllerLease,
  getChannelIdentity,
  getLastAcceptedWorkerSeq,
  listReconnectableChannels,
  releaseControllerLease,
  touchChannel,
} from "../lib/worker-channel/repository";
import {
  connectRun,
  disconnectRun,
  reconnectActiveChannels,
  sendCommand,
  shutdownAll,
} from "../lib/worker-channel/controller";
import {
  __resetReconnectTimingForTests,
  __setReconnectTimingForTests,
  getConnection,
} from "../lib/worker-channel/registry";
import {
  ControllerAbandonedError,
  ControllerConnection,
  __resetHeartbeatIntervalForTests,
  __setHeartbeatIntervalForTests,
} from "../lib/worker-channel/connection";
import { handleWorkerEvent } from "../lib/worker-channel/event-handler";
import {
  startWorkerServer,
  type WorkerServer,
  type WorkerSessionLike,
} from "../lib/worker-channel/worker-server";

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
    .set({ status, workerScope: `scope-${run.id}`})
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
  __resetHeartbeatIntervalForTests();
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

  it("boot re-adoption skips instances the provider reports stopped/gone", async () => {
    // A dead worker has nothing to adopt; dialing it would only burn the boot
    // deadline. The run's next turn provisions a fresh worker instead.
    const live = await provisionRun("running");
    const dead = await provisionRun("idle");
    await db.update(runnerInstances).set({ state: "gone" }).where(eq(runnerInstances.runId, dead.runId));

    const ids = (await listReconnectableChannels()).map((c) => c.runId);
    expect(ids).toContain(live.runId);
    expect(ids).not.toContain(dead.runId);
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

    // The provider observes the worker dead (this test spawned the worker itself,
    // so the real local provider has no record of it — inject the verdict); run
    // the shared orphan reaper. A chat run goes idle.
    const { installFakeRunnerProvider, setFakeRunLiveness } = await import("./helpers/fake-runner-provider");
    const { __resetRunnerProviderForTests } = await import("../lib/runner/provider");
    installFakeRunnerProvider();
    await setFakeRunLiveness(runId, { status: "dead", detail: "exited" }, "w1");
    const { reconcileOrphanedRuns } = await import("../lib/runs");
    await reconcileOrphanedRuns();
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, runId)))[0].status).toBe("idle");
    __resetRunnerProviderForTests();
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
      return inst.controllerId === null;
    });
  });

  it("stranded input re-dispatches a non-terminal run after its claim releases", async () => {
    // A chat run parked idle with its worker claim released and a follow-up
    // message stranded: the existing dispatch semantics re-claim and re-spawn.
    const run = await create({ goal: "<chat>", defer: true });
    runIds.push(run.id);
    await db
      .update(agentSessions)
      .set({ status: "idle", workerScope: null})
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

    // The fenced replica's channel touch is rejected; the current one passes.
    expect(await touchChannel(runId, channel.instanceId, "replica-a", a.epoch, new Date("2026-07-16T00:01:05Z"))).toBe(false);
    expect(await touchChannel(runId, channel.instanceId, "replica-b", b.epoch, new Date("2026-07-16T00:01:05Z"))).toBe(true);
  });

  // Regression: a Box/Fly checkpoint resume launches a brand-new worker process
  // but reuses the same channel instance id, so ControllerConnection dials in
  // under a BUMPED controller epoch while the run's original `run.start`
  // command (persisted, already acked) is still stamped with the OLD epoch.
  // ControllerConnection.sendPersisted silently no-ops on an epoch mismatch, so
  // naively replaying that stale command sends nothing — the fresh worker
  // connects, heartbeats forever, and never receives a bootstrap. A dispatch
  // that just (re)created the worker must mint a NEW run.start scoped to the
  // new epoch instead.
  it("freshWorker mints a new run.start after an epoch bump post-ack", async () => {
    const { runId, channel } = await provisionRun("preparing");
    const root = await newRoot();
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);

    await runDispatch.startChannelForRun(runId, channel.instanceId, { freshWorker: true });
    await waitFor(async () => (await commandRows(runId, "run.start")).length === 1);
    await waitFor(async () => (await commandRows(runId, "run.start")).every((r) => r.state === "acked"));
    const before = await db
      .select({ epoch: workerChannelCommands.controllerEpoch, id: workerChannelCommands.id })
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "run.start")));
    const firstEpoch = before[0].epoch;

    // Simulate the checkpoint/resume cycle: the connection drops, and by the
    // time the box comes back another actor (or simply an expired lease) has
    // bumped the epoch out from under this instance id.
    await disconnectRun(runId);
    const bumped = await acquireControllerLease(runId, "checkpoint-interloper", new Date());
    expect(bumped.epoch).toBeGreaterThan(firstEpoch);
    await releaseControllerLease(runId, "checkpoint-interloper", bumped.epoch);

    // The buggy version of startChannelForRun would find the OLD (acked, wrong-
    // epoch) command via its instance-only id, replay it through
    // sendPersisted — which silently drops any command whose epoch doesn't
    // match the connection's — and return, leaving exactly ONE row forever and
    // the fresh worker never bootstrapped. The fix mints a second, distinct
    // row scoped to the new epoch instead.
    await runDispatch.startChannelForRun(runId, channel.instanceId, { freshWorker: true });
    await waitFor(async () => (await commandRows(runId, "run.start")).length === 2);
    const after = await db
      .select({ epoch: workerChannelCommands.controllerEpoch, id: workerChannelCommands.id })
      .from(workerChannelCommands)
      .where(and(eq(workerChannelCommands.runId, runId), eq(workerChannelCommands.type, "run.start")));
    expect(new Set(after.map((r) => r.id)).size).toBe(2);
    const secondRow = after.find((r) => r.id !== before[0].id);
    expect(secondRow?.epoch).toBeGreaterThan(firstEpoch);
    expect(getConnection(runId)?.controllerEpoch).toBe(secondRow?.epoch);
  });

  // Counterpart: a plain re-adoption (control-plane restart re-dialing a worker
  // that may still be the SAME live process, freshWorker omitted) must NOT
  // mint or resend anything once an already-acked run.start exists from a
  // different epoch — the worker needs no re-kickoff, only its genuinely
  // pending commands, which connect()'s own rebase/replay already covers.
  it("a plain re-adoption never re-sends a stale-epoch run.start", async () => {
    const { runId, channel } = await provisionRun("running");
    const root = await newRoot();
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);

    await runDispatch.startChannelForRun(runId, channel.instanceId, { freshWorker: true });
    await waitFor(async () => (await commandRows(runId, "run.start")).length === 1);
    await waitFor(async () => (await commandRows(runId, "run.start")).every((r) => r.state === "acked"));

    await disconnectRun(runId);
    await acquireControllerLease(runId, "restart-interloper", new Date());

    await runDispatch.startChannelForRun(runId, channel.instanceId);
    expect((await commandRows(runId, "run.start")).length).toBe(1);
  });

  // Fix 1 (CRITICAL): epoch fencing must NOT reject a replayed worker event. The
  // worker stamps events with the epoch at emit time and replays them verbatim
  // from its durable outbox; a reconnect bumps the controller epoch, so the
  // replayed event legitimately carries an epoch below the current one. It must
  // be applied, not rejected with 4409.
  it("applies a replayed worker event stamped with an older controller epoch", async () => {
    const { runId, channel } = await provisionRun("running");
    const root = await newRoot();
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);

    // Connect under epoch N, then stand the controller down (releases the lease)
    // so the next connect bumps the epoch. The worker stays alive in its grace.
    const first = await connectRun(runId);
    const firstEpoch = first.controllerEpoch;
    await disconnectRun(runId);

    // The worker emits while no controller is attached: the event is spooled with
    // the OLD epoch and left UNACKED (no receipt persisted yet).
    const emitted = await server.emit("run.phase", { phase: "running" });
    expect(emitted.controllerEpoch).toBe(firstEpoch);
    expect(await getLastAcceptedWorkerSeq(runId, channel.instanceId)).toBe(0);

    // Reconnect: the epoch bumps, and the worker replays the old-epoch event right
    // after channel.accept. Pre-fix this looped forever on close code 4409; now it
    // is accepted and a receipt lands.
    const second = await connectRun(runId);
    expect(second.controllerEpoch).toBeGreaterThan(firstEpoch);
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId, channel.instanceId)) >= 1);
    expect(getConnection(runId)?.connected).toBe(true);
  });

  // Fix 5 (MODERATE): frames the worker replays during the post-accept handshake
  // awaits must not be dropped. Spool several events while detached and assert
  // every one lands after reconnect (the persistent listener is attached before
  // markChannelConnected/rebase/blobs.rebind now).
  it("does not drop worker frames replayed during the handshake window", async () => {
    const { runId, channel } = await provisionRun("running");
    const root = await newRoot();
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, root);

    await connectRun(runId);
    await disconnectRun(runId);

    // Three spooled, unacked events all replay immediately after the next accept.
    await server.emit("run.phase", { phase: "running" });
    await server.emit("agent.event", { event: { kind: "checkpoint" } });
    await server.emit("run.phase", { phase: "pushing" });
    expect(await getLastAcceptedWorkerSeq(runId, channel.instanceId)).toBe(0);

    await connectRun(runId);
    // All three are applied — none silently dropped in the handshake window.
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId, channel.instanceId)) >= 3);
    expect(getConnection(runId)?.connected).toBe(true);
  });

  // Fix 2 (CRITICAL): concurrent connect() must not build two sockets. The
  // in-flight guard makes later callers share the one attempt, so racing dials
  // (attemptReconnect timer + connectRun) can never orphan the
  // live socket with a losing one.
  it("collapses concurrent connect() calls into one live socket", async () => {
    const { runId, channel } = await provisionRun("running");
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());
    const identity = await getChannelIdentity(runId);
    if (!identity) throw new Error("missing channel identity");

    let socketCount = 0;
    const createSocket = (url: string, protocols: string[], opts: WebSocket.ClientOptions) => {
      socketCount += 1;
      return new WebSocket(url, protocols, opts);
    };
    const connection = new ControllerConnection({
      runId,
      instanceId: identity.instanceId,
      endpoint: identity.endpoint,
      controllerId: "wc_connect_race",
      onEvent: handleWorkerEvent,
      createSocket,
    });

    // Two overlapping dials on the same object; the guard shares one handshake so
    // only one socket is ever built (pre-fix both ran and one orphaned the other).
    await Promise.all([connection.connect(), connection.connect()]);
    expect(socketCount).toBe(1);
    expect(connection.connected).toBe(true);

    // The single surviving connection is functional: a worker event lands a receipt.
    await server.emit("run.phase", { phase: "running" });
    await waitFor(async () => (await getLastAcceptedWorkerSeq(runId, channel.instanceId)) >= 1);
    await connection.disconnect().catch(() => undefined);
  });

  // Fix 3 (MAJOR): an in-flight sendCommand must SETTLE when the grace expires,
  // never hang. The worker session here never acks, so the ack waiter can only be
  // settled by the abandon path — which rejects it with ControllerAbandonedError.
  it("settles an in-flight sendCommand when the reconnect grace expires", async () => {
    const { runId, channel } = await provisionRun("running");
    const silentSession: WorkerSessionLike = {
      attach: async () => {},
      receive: async () => {}, // never acknowledges the command
      emit: async () => ({}) as never,
      handshakeState: () => ({ lastControllerEpoch: 0, lastAckedControlSeq: 0, nextWorkerSeq: 1 }),
      abort: () => {},
      close: async () => {},
    };
    const server = await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot(), {
      session: silentSession,
    });
    await connectRun(runId);

    let outcome: "pending" | "resolved" | "rejected" = "pending";
    let error: unknown;
    const inFlight = sendCommand(runId, "run.cancel", { reason: "stop", requestId: "r", deadline: null }).then(
      () => { outcome = "resolved"; },
      (caught) => { outcome = "rejected"; error = caught; },
    );

    // Once the command row exists, the connection was connected: the ack waiter is
    // registered and the command was sent. Now drop the worker so it can never be
    // reconnected and the grace lapses.
    await waitFor(async () => (await commandRows(runId, "run.cancel")).length > 0);
    await server.close();

    await waitFor(() => outcome !== "pending", 4000);
    await inFlight;
    expect(outcome).toBe("rejected");
    expect(error).toBeInstanceOf(ControllerAbandonedError);
  });

  // Fix 4 (MAJOR): a half-open socket that swallows pongs keeps readyState OPEN
  // forever. After two missed intervals the controller must terminate it so the
  // registry's reconnect path takes over.
  it("terminates a socket that stops answering pongs", async () => {
    const { runId, channel } = await provisionRun("running");
    await bootServer(runId, channel.instanceId, channel.listenEndpoint, await newRoot());
    const identity = await getChannelIdentity(runId);
    if (!identity) throw new Error("missing channel identity");

    __setHeartbeatIntervalForTests(30);
    // Suppress the 'pong' event on the control socket so the peer's auto-pong
    // never resets the missed-pong counter — a half-open socket in every respect
    // that matters to the liveness check.
    const createSocket = (url: string, protocols: string[], opts: WebSocket.ClientOptions) => {
      const socket = new WebSocket(url, protocols, opts);
      const on = socket.on.bind(socket);
      (socket as unknown as { on: WebSocket["on"] }).on = ((event: string, listener: (...args: unknown[]) => void) =>
        event === "pong" ? socket : on(event as never, listener as never)) as WebSocket["on"];
      return socket;
    };

    let closedCode: number | undefined;
    const connection = new ControllerConnection({
      runId,
      instanceId: identity.instanceId,
      endpoint: identity.endpoint,
      controllerId: "wc_pong_test",
      onEvent: handleWorkerEvent,
      onClose: (info) => { closedCode = info.code; },
      createSocket,
    });
    await connection.connect();
    expect(connection.connected).toBe(true);

    await waitFor(() => closedCode !== undefined, 4000);
    expect(connection.connected).toBe(false);
    void channel;
    await connection.disconnect().catch(() => undefined);
  });
});
