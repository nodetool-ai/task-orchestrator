import { randomUUID } from "node:crypto";
import { getChannelIdentity, persistCommand, type CommandRow } from "./repository";
import { ControllerConnection, type ControllerConnectionOptions, type WorkerEventHandler } from "./connection";

const REGISTRY = Symbol.for("task-orchestrator.worker-channel.registry");
type Registry = { controllerId: string; connections: Map<number, ControllerConnection> };
function registry(): Registry {
  const root = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
  return (root[REGISTRY] ??= { controllerId: `wc_${randomUUID()}`, connections: new Map() });
}
export function getConnection(runId: number): ControllerConnection | undefined { return registry().connections.get(runId); }
export async function connectRun(runId: number, options: Omit<Partial<ControllerConnectionOptions>, "runId" | "instanceId" | "endpoint" | "controllerId"> = {}): Promise<ControllerConnection> {
  const current = getConnection(runId);
  if (current) return current;
  const identity = await getChannelIdentity(runId);
  if (!identity) throw new Error(`Run ${runId} has no worker channel endpoint or instance identity`);
  const connection = new ControllerConnection({ ...options, ...identity, runId, controllerId: registry().controllerId });
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
export async function shutdownAll(): Promise<void> { await Promise.all([...registry().connections.keys()].map(disconnectRun)); }
export type { WorkerEventHandler };
