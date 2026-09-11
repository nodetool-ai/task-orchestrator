import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearChannelClaim,
  getChannelIdentity,
  hasReconnectableWork,
  listReconnectableChannels,
  persistCommand,
  releaseChannelForReplacement,
  type CommandRow,
} from "./repository";
import {
  ControllerConnection,
  ControllerProtocolError,
  type ControllerConnectionOptions,
  type WorkerEventHandler,
} from "./connection";
import { BlobCoordinator, type BlobWireIO } from "./blob-transfer";
import { handleWorkerEvent } from "./event-handler";
import { CLOSE_CODE_PROTOCOL_MISMATCH, CLOSE_CODE_STALE_CONTROLLER_EPOCH, DEFAULT_DISCONNECT_GRACE_MS } from "./protocol";

const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");

// When a Fly run parks (status → parked/idle), the control-plane WebSocket
// stays open. The Fly Machine is later suspended via the lifecycle sweep;
// the channel remains until the next resume (or until the machine is destroyed).
// For Sprites, an open proxy tunnel counts as activity and would keep the
// sprite billing forever, so sprites runs must close the channel at turn end
// (idle/parked/terminal) after the final frame is acked. The next dispatchRun
// re-dials and wakes the sprite. See maybeCloseSpritesChannel below.

/** One supervised run channel: the live connection plus its reconnect state. */
type Supervisor = {
  runId: number;
  instanceId: string;
  workerGeneration: number;
  connection: ControllerConnection;
  /** Set true by an intentional disconnect so the reconnect loop stands down. */
  stopped: boolean;
  /** Absolute time (ms) the reconnect grace expires; undefined when connected. */
  graceDeadline?: number;
  reconnectTimer?: NodeJS.Timeout;
};

type Registry = {
  controllerId: string;
  supervisors: Map<number, Supervisor>;
  blobs: Map<number, BlobCoordinator>;
};

function registry(): Registry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  return (root[REGISTRY] ??= {
    controllerId: `wc_${randomUUID()}`,
    supervisors: new Map(),
    blobs: new Map(),
  });
}

/** Reconnect timing. Overridable for tests so the 60s grace does not stall a
 * unit run; production uses the protocol's disconnect grace. */
type ReconnectTiming = { graceMs: number; backoffMs: number };
let reconnectTiming: ReconnectTiming = { graceMs: DEFAULT_DISCONNECT_GRACE_MS, backoffMs: 1_000 };
export function __setReconnectTimingForTests(timing: Partial<ReconnectTiming>): void {
  reconnectTiming = { ...reconnectTiming, ...timing };
}
export function __resetReconnectTimingForTests(): void {
  reconnectTiming = { graceMs: DEFAULT_DISCONNECT_GRACE_MS, backoffMs: 1_000 };
}

export function getConnection(runId: number): ControllerConnection | undefined {
  return registry().supervisors.get(runId)?.connection;
}

/** A coordinator with a detached transport. Every `connect()` rebinds it to the
 * live connection, so this placeholder io is never actually used. */
function detachedBlobIO(): BlobWireIO {
  return { sendBlobOpen() {}, sendBlobAccepted() {}, sendBlobRejected() {}, sendBinary() {} };
}

/** One durable blob coordinator per run, reused across reconnects so two
 * connections never race over the same on-disk blob store. */
function blobCoordinatorFor(runId: number, instanceId: string): BlobCoordinator {
  const existing = registry().blobs.get(runId);
  if (existing) return existing;
  const blobRoot = join(tmpdir(), "task-orchestrator", "channel-blobs", `${runId}-${instanceId}`);
  const created = new BlobCoordinator(blobRoot, detachedBlobIO());
  registry().blobs.set(runId, created);
  return created;
}

export async function connectRun(
  runId: number,
  options: Omit<
    Partial<ControllerConnectionOptions>,
    "runId" | "instanceId" | "endpoint" | "controllerId" | "onClose" | "onTerminal"
  > & { bumpEpoch?: boolean } = {},
): Promise<ControllerConnection> {
  const { bumpEpoch, ...connectionOptions } = options;
  // Resolve the durable identity before consulting the in-memory supervisor.
  // A run can be re-dispatched while an old socket is still connected; reusing
  // that cached controller would let old frames cross the new generation.
  const identity = await getChannelIdentity(runId);
  let existing = registry().supervisors.get(runId);
  if (existing && identity && (existing.instanceId !== identity.instanceId || existing.workerGeneration !== identity.workerGeneration)) {
    existing.stopped = true;
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    registry().supervisors.delete(runId);
    registry().blobs.delete(runId);
    await existing.connection.disconnect(false).catch(() => undefined);
    existing = undefined;
  }
  if (existing?.connection.shutDown) {
    // A stood-down connection (the sprites idle close after every turn calls
    // disconnect(false) but keeps the supervisor registered) can never dial
    // again: connect() throws "controller connection is shut down". Drop it and
    // build a fresh connection below; the blob coordinator is kept (run 187).
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    registry().supervisors.delete(runId);
    existing = undefined;
  }
  if (existing && bumpEpoch) {
    // An explicit takeover must replace even a connected cached controller.
    // Otherwise the caller asks for a new epoch but silently keeps commanding
    // the old lease.
    existing.stopped = true;
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    registry().supervisors.delete(runId);
    await existing.connection.disconnect(false).catch(() => undefined);
    existing = undefined;
  }
  if (existing) {
    existing.stopped = false;
    // Cancel any pending reconnect backoff and clear the grace so this connect and
    // the attemptReconnect timer do not dial the same connection concurrently — a
    // losing socket from the other dial could otherwise orphan the live one. The
    // connect() re-entrancy guard also collapses concurrent dials, but clearing
    // the timer keeps a stale backoff from firing after we reconnect here.
    existing.graceDeadline = undefined;
    if (existing.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
      existing.reconnectTimer = undefined;
    }
    if (!existing.connection.connected) await existing.connection.connect({ bumpEpoch });
    return existing.connection;
  }
  if (!identity) throw new Error(`Run ${runId} has no worker channel endpoint or instance identity`);
  const blobs = blobCoordinatorFor(runId, identity.instanceId);
  const supervisor: Supervisor = {
    runId,
    instanceId: identity.instanceId,
    workerGeneration: identity.workerGeneration,
    stopped: false,
    connection: undefined as unknown as ControllerConnection,
  };
  supervisor.connection = new ControllerConnection({
    onEvent: handleWorkerEvent,
    blobs,
    ...connectionOptions,
    ...identity,
    runId,
    controllerId: registry().controllerId,
    onClose: () => scheduleReconnect(supervisor),
    // Capture this supervisor, not a later registry entry for the same run.
    // A replacement generation can connect before the old terminal callback
    // drains its microtask queue.
    onTerminal: (info) => void finalizeTerminalRun(supervisor, info.status).catch(() => undefined),
  });
  registry().supervisors.set(runId, supervisor);
  try {
    await supervisor.connection.connect({ bumpEpoch });
    return supervisor.connection;
  } catch (error) {
    // A timed-out dial may settle after a replacement generation has already
    // installed its supervisor. Cleanup is fenced to the object that failed.
    if (registry().supervisors.get(runId) === supervisor) {
      registry().supervisors.delete(runId);
      registry().blobs.delete(runId);
    }
    if (error instanceof ControllerProtocolError && error.closeCode === CLOSE_CODE_PROTOCOL_MISMATCH) {
      // The worker at this endpoint speaks an incompatible protocol. Replace it
      // with a fresh worker built from the current image before surfacing the
      // failure to the caller.
      await replaceWorker(runId).catch(() => undefined);
    }
    throw error;
  }
}

/** Schedule the bounded reconnect grace after an unexpected socket drop. A
 * provider-live worker's listener comes back and a reconnect within the grace
 * window resumes the same durable session; a provider-dead worker's dials keep
 * failing until the grace lapses, after which the run is left to the heartbeat
 * reaper's re-dispatch/idle/fail policy. */
function scheduleReconnect(supervisor: Supervisor): void {
  if (supervisor.stopped) return;
  if (supervisor.graceDeadline == null) {
    supervisor.graceDeadline = Date.now() + reconnectTiming.graceMs;
  }
  if (supervisor.reconnectTimer) return;
  supervisor.reconnectTimer = setTimeout(() => {
    supervisor.reconnectTimer = undefined;
    void attemptReconnect(supervisor);
  }, reconnectTiming.backoffMs);
  supervisor.reconnectTimer.unref?.();
}

async function attemptReconnect(supervisor: Supervisor): Promise<void> {
  if (supervisor.stopped) return;
  // Give up if this supervisor was already replaced by a fresh connectRun.
  if (registry().supervisors.get(supervisor.runId) !== supervisor) return;
  // A concurrent connectRun may already have reconnected this
  // supervisor while the backoff timer was pending; do not dial a second socket
  // on top of the live one.
  if (supervisor.connection.connected) {
    supervisor.graceDeadline = undefined;
    return;
  }
  try {
    await supervisor.connection.connect();
    supervisor.graceDeadline = undefined; // reconnected within grace
  } catch (error) {
    // Reconnect failures must be visible: a silent dial loop is
    // indistinguishable from a healthy idle channel in the logs.
    console.error(
      `worker-channel: reconnect attempt failed for run ${supervisor.runId}:`,
      error instanceof Error ? error.message : error
    );
    if (error instanceof ControllerProtocolError && error.closeCode === CLOSE_CODE_PROTOCOL_MISMATCH) {
      // The worker speaks an incompatible protocol: replace it with the current
      // image rather than burning the reconnect grace on a hopeless dial.
      supervisor.stopped = true;
      registry().supervisors.delete(supervisor.runId);
      registry().blobs.delete(supervisor.runId);
      await replaceWorker(supervisor.runId).catch(() => undefined);
      return;
    }
    if (error instanceof ControllerProtocolError && error.closeCode === CLOSE_CODE_STALE_CONTROLLER_EPOCH) {
      // Another controller owns this run's epoch now. Redialing would bump the
      // epoch and steal it back — a ping-pong for as long as both live. Stand
      // down; the owner drives the run.
      supervisor.stopped = true;
      registry().supervisors.delete(supervisor.runId);
      registry().blobs.delete(supervisor.runId);
      return;
    }
    if (Date.now() < (supervisor.graceDeadline ?? 0)) {
      scheduleReconnect(supervisor);
      return;
    }
    // Grace exhausted: abandon the channel and let the heartbeat reaper act. The
    // run's heartbeat has gone stale (channel activity stopped bumping it), so
    // reconcileOrphanedRuns applies the re-dispatch/idle/fail policy. abandon()
    // REJECTS any in-flight sendCommand ack waiters — no reconnect will replay
    // those commands from here, so their callers must not hang forever nor observe
    // a false success (they would otherwise never settle: the durable row is not a
    // delivery guarantee once this supervisor is gone).
    supervisor.stopped = true;
    await supervisor.connection.abandon().catch(() => undefined);
    registry().supervisors.delete(supervisor.runId);
    registry().blobs.delete(supervisor.runId);
  }
}

/** Protocol-mismatch replacement: abandon the incompatible worker instance and
 * dispatch a fresh one built from the current image. */
async function replaceWorker(runId: number): Promise<void> {
  const runDispatch = await import("../run-dispatch");
  const scope = await currentWorkerScope(runId);
  if (scope) await runDispatch.stopRunner(scope).catch(() => undefined);
  await releaseChannelForReplacement(runId);
  await runDispatch.dispatchRun(runId).catch(() => undefined);
}

/** Terminal teardown: the run landed completed/failed/cancelled. Stand the
 * channel down (without racing the run.commit off the wire — the worker closes
 * its own side after receiving it), stop the provider where appropriate, and
 * clear the controller lease and worker claim. */
async function finalizeTerminalRun(supervisor: Supervisor, status: string): Promise<void> {
  const runId = supervisor.runId;
  if (registry().supervisors.get(runId) !== supervisor || supervisor.stopped) return;
  supervisor.stopped = true;
  if (supervisor.reconnectTimer) clearTimeout(supervisor.reconnectTimer);
  supervisor.connection.neutralize();
  let cleaned = false;
  let cleanupError: unknown;
  if (status === "failed") {
    const { db } = await import("../../db");
    const { agentSessions, runnerInstances } = await import("../../db/schema");
    const { eq } = await import("drizzle-orm");
    const [run] = await db.select({ provider: runnerInstances.provider })
      .from(agentSessions).innerJoin(runnerInstances, eq(runnerInstances.runId, agentSessions.id))
      .where(eq(agentSessions.id, runId));
    if (run?.provider === "sprites") {
      // A failed run remains resumable. Stop only its service and retain the
      // Sprite filesystem, checkout, dependencies, and backend session.
      for (const delay of [0, 100, 500]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          cleaned = await stopIdleSpriteGeneration(runId, supervisor.instanceId, supervisor.workerGeneration);
          if (cleaned || registry().supervisors.get(runId) !== supervisor) break;
        } catch (error) {
          cleanupError = error;
        }
      }
      if (!cleaned && registry().supervisors.get(runId) === supervisor) {
        await quarantineTerminalCleanup(supervisor, cleanupError ?? new Error("failed Sprite service was not quiesced"));
        return;
      }
      if (registry().supervisors.get(runId) === supervisor) {
        registry().supervisors.delete(runId);
        registry().blobs.delete(runId);
      }
      return;
    }
  }
  const scope = await currentWorkerScope(runId);
  const runDispatch = await import("../run-dispatch");
  for (const delay of [0, 100, 500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await runDispatch.stopRunner(scope, { runId, workerGeneration: supervisor.workerGeneration, instanceId: supervisor.instanceId });
      await clearChannelClaim(runId, { workerGeneration: supervisor.workerGeneration, instanceId: supervisor.instanceId });
      cleaned = true;
      break;
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!cleaned) {
    await quarantineTerminalCleanup(supervisor, cleanupError ?? new Error("terminal provider cleanup was not confirmed"));
    return;
  }
  if (registry().supervisors.get(runId) === supervisor) {
    registry().supervisors.delete(runId);
    registry().blobs.delete(runId);
  }
}

async function quarantineTerminalCleanup(supervisor: Supervisor, error: unknown): Promise<void> {
  const { db } = await import("../../db");
  const { agentEvents, agentSessions, runnerInstances } = await import("../../db/schema");
  const { and, eq, sql } = await import("drizzle-orm");
  const detail = error instanceof Error ? error.message : String(error);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT run_id FROM runner_instances WHERE run_id=${supervisor.runId} FOR UPDATE`);
    const rows = await tx.update(runnerInstances).set({ generationState: "stopping", lastProviderError: detail }).where(and(
      eq(runnerInstances.runId, supervisor.runId), eq(runnerInstances.workerGeneration, supervisor.workerGeneration),
      eq(runnerInstances.channelInstanceId, supervisor.instanceId),
    )).returning({ spriteName: runnerInstances.spriteName });
    if (!rows.length) return;
    if (rows[0].spriteName) await tx.update(agentSessions).set({ workerScope: rows[0].spriteName }).where(eq(agentSessions.id, supervisor.runId));
    await tx.insert(agentEvents).values({ sessionId: supervisor.runId, type: "runner_terminal_cleanup_blocked",
      payload: JSON.stringify({ worker_generation: supervisor.workerGeneration, instance_id: supervisor.instanceId, error: detail }) });
  });
  console.error(`[worker-channel] terminal cleanup quarantined for run ${supervisor.runId}: ${detail}`);
}

async function currentWorkerScope(runId: number): Promise<string | null> {
  const { db } = await import("../../db");
  const { agentSessions } = await import("../../db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ workerScope: agentSessions.workerScope })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId))
    .limit(1);
  return rows[0]?.workerScope ?? null;
}

export async function disconnectRun(runId: number, options: {
  release?: boolean;
  instanceId?: string;
  workerGeneration?: number;
  discardBlobs?: boolean;
} = {}): Promise<void> {
  const supervisor = registry().supervisors.get(runId);
  if (supervisor && ((options.instanceId != null && supervisor.instanceId !== options.instanceId)
    || (options.workerGeneration != null && supervisor.workerGeneration !== options.workerGeneration))) return;
  registry().supervisors.delete(runId);
  if (options.discardBlobs) registry().blobs.delete(runId);
  if (!supervisor) return;
  supervisor.stopped = true;
  if (supervisor.reconnectTimer) clearTimeout(supervisor.reconnectTimer);
  await supervisor.connection.disconnect(options.release ?? true);
}

export async function sendCommand(runId: number, type: string, payload: unknown, id?: string): Promise<void> {
  const connection = getConnection(runId);
  if (!connection) throw new Error(`No worker channel is registered for run ${runId}`);
  const row: CommandRow = await persistCommand({ runId, instanceId: connection.instanceId, workerGeneration: connection.workerGeneration, controllerEpoch: connection.controllerEpoch, type, payload, id });
  // A disconnected controller has no acknowledgement path. The durable row is
  // the delivery promise in that state; connect() rebases and replays it.
  if (!connection.connected) return;
  const ack = connection.waitForAck(row.seq);
  await connection.sendPersisted(row);
  await ack;
}

/**
 * Re-adopt every active worker channel on control-plane startup. A fresh (boot)
 * or hot-deployed process scans the runner instances that still carry a dial
 * identity for a non-terminal run, acquires each controller lease, and reconnects
 * to the stored endpoint. Best-effort per run: a worker that is genuinely gone
 * fails to dial and is left to the reaper. Returns the count that reconnected.
 */
export async function reconnectActiveChannels(): Promise<number> {
  const channels = await listReconnectableChannels();
  let reconnected = 0;
  // Re-adoption used to be fully sequential. One stale channel then consumed
  // the complete boot-backoff window before any later run was even attempted
  // (runs 206-208 were stranded behind run 204). A small worker pool bounds
  // provider pressure while removing that head-of-line failure mode.
  let next = 0;
  const adopt = async () => {
    for (;;) {
      const index = next++;
      const channel = channels[index];
      if (!channel) return;
      try {
        if (channel.status === "idle") {
          // Boot recovery must quiesce an already-running idle Sprite service;
          // merely omitting run.start leaves the provider supervisor free to
          // restart the worker forever.
          if (!(await hasReconnectableWork(channel.runId))) {
            if (await stopIdleSpriteGeneration(channel.runId, channel.instanceId, channel.workerGeneration)) continue;
            // Work may have arrived while quiescence waited for its lock.
            if (!(await hasReconnectableWork(channel.runId))) continue;
          }
        }
        // startChannelForRun (not a bare connectRun): an adopted channel whose
        // dispatch died before persisting `run.start` would otherwise sit
        // connected-but-idle forever.
        const runDispatch = await import("../run-dispatch");
        await runDispatch.startChannelForRun(channel.runId, channel.instanceId);
        reconnected++;
      } catch {
        // Worker unreachable (dead process / socket gone): the reaper owns it.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, channels.length) }, () => adopt()));
  return reconnected;
}

async function stopIdleSpriteGeneration(runId: number, instanceId: string, generation: number): Promise<boolean> {
  const { db } = await import("../../db");
  const { runnerInstances } = await import("../../db/schema");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await db.select({ provider: runnerInstances.provider, spriteName: runnerInstances.spriteName, providerServiceName: runnerInstances.providerServiceName })
    .from(runnerInstances).where(and(eq(runnerInstances.runId, runId), eq(runnerInstances.channelInstanceId, instanceId))).limit(1);
  if (!row || row.provider !== "sprites" || !row.spriteName) return false;
  const { SpritesRunnerProvider } = await import("../runner/sprites");
  const provider = new SpritesRunnerProvider();
  const ref = { runId, generation, instanceId, providerHandle: row.spriteName, ...(row.providerServiceName ? { providerServiceName: row.providerServiceName } : {}) };
  return provider.quiesceIdleGeneration(ref);
}

/**
 * Shut every channel down. An INTENTIONAL full shutdown drains: it sends
 * `channel.drain` so each worker finalizes and exits cleanly before the socket
 * closes. A hot deploy (`drain: false`, the default) simply closes the sockets;
 * the workers keep running and the next process re-adopts them via
 * {@link reconnectActiveChannels}.
 */
export async function shutdownAll(options: { drain?: boolean } = {}): Promise<void> {
  const supervisors = [...registry().supervisors.values()];
  if (options.drain) {
    await Promise.all(
      supervisors.map(async (supervisor) => {
        try {
          await sendCommand(supervisor.runId, "channel.drain", { reason: "control-plane shutdown" });
        } catch {
          // best-effort: an unreachable worker still gets its socket closed below
        }
      }),
    );
  }
  await Promise.all(supervisors.map((supervisor) => disconnectRun(supervisor.runId)));
  registry().blobs.clear();
}

/**
 * For sprites only: close the proxy tunnel when a run leaves the active states.
 * An open tunnel is activity and would keep the sprite awake and billing.
 * The next `dispatchRun` will re-dial and wake it. Normal close code 1000 is
 * used so the worker sees a clean shutdown. Local and Fly endpoints are left
 * open (their lifecycle is via suspend/stop, not via channel close).
 */
export async function maybeCloseSpritesChannel(runId: number): Promise<void> {
  const supervisor = registry().supervisors.get(runId);
  if (!supervisor || supervisor.stopped) return;
  const identity = await getChannelIdentity(runId);
  if (!identity?.endpoint || !identity.endpoint.startsWith("sprite://")) return;
  // Check current run status — only close when idle/parked/terminal
  const { db } = await import("../../db");
  const { agentSessions } = await import("../../db/schema");
  const { eq } = await import("drizzle-orm");
  const rows = await db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, runId)).limit(1);
  const status = rows[0]?.status;
  if (!status || !["idle", "parked", "completed", "failed", "cancelled", "closed", "budget_exhausted"].includes(status)) return;
  // A durable input/event or unfinished v2 turn is an actionable wake, even
  // when the status briefly says idle. Leave the channel and provider alive so
  // a follow-up racing this callback is delivered to the existing generation.
  // The repository query is intentionally fail-closed: a transient database
  // error must not turn an in-flight follow-up into a lost wake.
  try {
    if (status === "idle" && await hasReconnectableWork(runId)) return;
  } catch {
    return;
  }
  // A command the worker has not acked yet (its run.start, an input) is in
  // flight on this very channel: closing now loses it, and sendPersisted has
  // nothing to reconnect to. This happens for real — a fresh worker replays
  // its predecessor's spooled `run.phase idle` on connect, and that idle
  // landed here a tick before the new generation's run.start went out
  // (run 187, 2026-08-27). The next idle after delivery closes the tunnel.
  const { listPendingCommands } = await import("./repository");
  let pending: Awaited<ReturnType<typeof listPendingCommands>>;
  try {
    pending = await listPendingCommands(runId, supervisor.instanceId, supervisor.connection.controllerEpoch, supervisor.workerGeneration);
  } catch {
    return;
  }
  if (pending.length > 0) return;
  // Stop after the final frame's ack is flushed. The provider holds the run
  // and channel locks through the stop; follow-ups cannot reach a service
  // that cleanup has decided to stop. Keep the filesystem for resume.
  setTimeout(() => {
    void (async () => {
      if (supervisor.stopped || registry().supervisors.get(runId) !== supervisor) return;
      // Suppress automatic reconnect during the provider stop.
      supervisor.stopped = true;
      try {
        if (["idle", "parked", "failed"].includes(status)) {
          if (!(await stopIdleSpriteGeneration(runId, supervisor.instanceId, supervisor.workerGeneration))) {
            supervisor.stopped = false;
            return;
          }
        }
        if (supervisor.reconnectTimer) clearTimeout(supervisor.reconnectTimer);
        if (supervisor.connection.connected) await supervisor.connection.disconnect(false);
        if (registry().supervisors.get(runId) === supervisor) registry().supervisors.delete(runId);
      } catch (error) {
        supervisor.stopped = false;
        console.error(`[worker-channel] unable to quiesce Sprite run ${runId}`, error);
      }
    })();
  }, 0);
}

export type { WorkerEventHandler };
