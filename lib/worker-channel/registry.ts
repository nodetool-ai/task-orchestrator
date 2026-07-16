import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannelIdentity, persistCommand, type CommandRow } from "./repository";
import { ControllerConnection, type ControllerConnectionOptions, type WorkerEventHandler } from "./connection";
import { BlobCoordinator, type BlobWireIO } from "./blob-transfer";
import { handleWorkerEvent } from "./event-handler";

const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");
type Registry = {
  controllerId: string;
  connections: Map<number, ControllerConnection>;
  blobs: Map<number, BlobCoordinator>;
};
function registry(): Registry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  return (root[REGISTRY] ??= { controllerId: `wc_${randomUUID()}`, connections: new Map(), blobs: new Map() });
}
export function getConnection(runId: number): ControllerConnection | undefined { return registry().connections.get(runId); }

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

export async function connectRun(runId: number, options: Omit<Partial<ControllerConnectionOptions>, "runId" | "instanceId" | "endpoint" | "controllerId"> = {}): Promise<ControllerConnection> {
  const current = getConnection(runId);
  if (current) return current;
  const identity = await getChannelIdentity(runId);
  if (!identity) throw new Error(`Run ${runId} has no worker channel endpoint or instance identity`);
  const blobs = blobCoordinatorFor(runId, identity.instanceId);
  const connection = new ControllerConnection({ onEvent: handleWorkerEvent, blobs, ...options, ...identity, runId, controllerId: registry().controllerId });
  registry().connections.set(runId, connection);
  try { await connection.connect(); return connection; } catch (error) { registry().connections.delete(runId); throw error; }
}
export async function disconnectRun(runId: number): Promise<void> { const connection = registry().connections.get(runId); registry().connections.delete(runId); await connection?.disconnect(); }
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
export async function shutdownAll(): Promise<void> {
  await Promise.all([...registry().connections.keys()].map(disconnectRun));
  registry().blobs.clear();
}
export type { WorkerEventHandler };
