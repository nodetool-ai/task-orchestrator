import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearChannelClaim,
  getChannelIdentity,
  listReconnectableChannels,
  listStaleChannelRuns,
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
import { CLOSE_CODE_PROTOCOL_MISMATCH, DEFAULT_DISCONNECT_GRACE_MS } from "./protocol";

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
  > = {},
): Promise<ControllerConnection> {
  const existing = registry().supervisors.get(runId);
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
    if (!existing.connection.connected) await existing.connection.connect();
    return existing.connection;
  }
  const identity = await getChannelIdentity(runId);
  if (!identity) throw new Error(`Run ${runId} has no worker channel endpoint or instance identity`);
  const blobs = blobCoordinatorFor(runId, identity.instanceId);
  const supervisor: Supervisor = {
    runId,
    instanceId: identity.instanceId,
    stopped: false,
    connection: undefined as unknown as ControllerConnection,
  };
  supervisor.connection = new ControllerConnection({
    onEvent: handleWorkerEvent,
    blobs,
    ...options,
    ...identity,
    runId,
    controllerId: registry().controllerId,
    onClose: () => scheduleReconnect(supervisor),
    onTerminal: (info) => void finalizeTerminalRun(runId, info.status).catch(() => undefined),
  });
  registry().supervisors.set(runId, supervisor);
  try {
    await supervisor.connection.connect();
    return supervisor.connection;
  } catch (error) {
    registry().supervisors.delete(runId);
    registry().blobs.delete(runId);
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
  // A concurrent connectRun/reapStaleChannels may already have reconnected this
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
async function finalizeTerminalRun(runId: number, _status: string): Promise<void> {
  const supervisor = registry().supervisors.get(runId);
  if (!supervisor || supervisor.stopped) return;
  supervisor.stopped = true;
  if (supervisor.reconnectTimer) clearTimeout(supervisor.reconnectTimer);
  supervisor.connection.neutralize();
  registry().supervisors.delete(runId);
  registry().blobs.delete(runId);
  const scope = await currentWorkerScope(runId);
  const runDispatch = await import("../run-dispatch");
  if (scope) await runDispatch.stopRunner(scope).catch(() => undefined);
  await clearChannelClaim(runId).catch(() => undefined);
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

export async function disconnectRun(runId: number): Promise<void> {
  const supervisor = registry().supervisors.get(runId);
  registry().supervisors.delete(runId);
  if (!supervisor) return;
  supervisor.stopped = true;
  if (supervisor.reconnectTimer) clearTimeout(supervisor.reconnectTimer);
  await supervisor.connection.disconnect();
}

export async function sendCommand(runId: number, type: string, payload: unknown, id?: string): Promise<void> {
  const connection = getConnection(runId);
  if (!connection) throw new Error(`No worker channel is registered for run ${runId}`);
  const row: CommandRow = await persistCommand({ runId, instanceId: connection.instanceId, controllerEpoch: connection.controllerEpoch, type, payload, id });
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
  for (const channel of channels) {
    try {
      // startChannelForRun (not a bare connectRun): an adopted channel whose
      // dispatch died before persisting `run.start` would otherwise sit
      // connected-but-idle forever — channel liveness keeps bumping the
      // heartbeat, so the reaper never rescues it. `freshWorker` is omitted
      // (false): this is a RE-ADOPTION, not a provider create()/resume() — the
      // worker process may be the same live one from before this control-plane
      // restart, so an already-started instance gets no re-sent/rebuilt
      // command, only the one true gap (no run.start ever persisted) is filled.
      const runDispatch = await import("../run-dispatch");
      await runDispatch.startChannelForRun(channel.runId, channel.instanceId);
      reconnected++;
    } catch {
      // Worker unreachable (dead process / socket gone): the heartbeat reaper
      // owns it. Do not fail startup.
    }
  }
  return reconnected;
}

/**
 * Detect stale worker channels off `channel_last_seen_at` (never a worker
 * heartbeat request) and nudge each toward recovery. A run in a lease status
 * whose channel has been silent past the grace window and has NO live connected
 * supervisor is reconnected; a still-dead worker's dial fails and the run is left
 * to the heartbeat reaper's re-dispatch/idle/fail policy. Runs every pump tick.
 * Returns the number of stale channels a reconnect recovered.
 */
export async function reapStaleChannels(): Promise<number> {
  const staleBefore = new Date(Date.now() - reconnectTiming.graceMs);
  const stale = await listStaleChannelRuns(staleBefore);
  let recovered = 0;
  for (const channel of stale) {
    const supervisor = registry().supervisors.get(channel.runId);
    if (supervisor && supervisor.connection.connected) continue; // already live
    try {
      await connectRun(channel.runId);
      recovered++;
    } catch {
      // Worker unreachable: the heartbeat reaper (reconcileOrphanedRuns) owns it.
    }
  }
  return recovered;
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
  // Close after the final frame's ack is flushed — next tick
  setTimeout(() => {
    if (supervisor.connection.connected) {
      void supervisor.connection.disconnect(false).catch(() => undefined);
    }
  }, 0);
}

export type { WorkerEventHandler };
