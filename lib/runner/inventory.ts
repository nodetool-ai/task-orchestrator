// lib/runner/inventory.ts
// Runner cost/inventory view: reconcile live Fly Machines + Volumes and expose
// persisted Box mappings. Operators can see what belongs to a run, how old it
// is, roughly what it costs, and which Fly volumes have leaked (orphans). Box
// rows are deliberately DB-only here: inventory must not cause lifecycle API
// calls or wake an archived Box.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runnerInstances, agentSessions } from "@/db/schema";
import { makeFlyClient, type FlyClient, type FlyMachine, type FlyVolume } from "./fly-client";
import { redactBoxErrorText } from "./box-errors";

/** Fly volume storage list price. This is an ESTIMATE for visibility only —
 *  actual billing depends on region and any negotiated pricing. */
export const VOLUME_USD_PER_GB_MONTH = 0.15;

export interface RunnerInventoryRow {
  /** The resource family. Existing Fly rows remain `fly`; Box rows are additive. */
  provider: "fly" | "box";
  runId: number | null; // from runner_instances (may be null for a volume with no mapping row)
  machineId: string | null;
  machineState: string | null; // live Fly state, or null if machine absent/gone
  volumeId: string | null;
  volumeName: string | null;
  volumeState: string | null;
  sizeGb: number | null;
  region: string | null;
  runStatus: string | null; // agentSessions.status
  ageMs: number | null; // now - runner_instances.createdAt (or volume.createdAt fallback)
  orphan: boolean; // no attached machine AND no non-gone runner_instances row
  estMonthlyCostUsd: number; // sizeGb * VOLUME_USD_PER_GB_MONTH
  /** Normalized state persisted in runner_instances; null for unmapped Fly volumes. */
  runnerState: string | null;

  // Persisted Box context. These stay null for Fly output so existing consumers
  // retain their machine/volume fields unchanged.
  boxId: string | null;
  /** The persisted (normalized) Box state. Inventory performs no live Box read. */
  boxState: string | null;
  boxTemplateId: string | null;
  boxSourceId: string | null;
  workerVersion: string | null;
  snapshotId: string | null;
  checkpointStatus: "completed" | "pending" | null;
  checkpointAgeMs: number | null;
  /** Estimated current active period; null once a Box is stopped/gone. */
  activeDurationMs: number | null;
  /** Redacted, capped diagnostic text retained from the provider. */
  lastProviderError: string | null;
}

export interface RunnerInventory {
  rows: RunnerInventoryRow[];
  totals: {
    machines: number;
    volumes: number;
    totalGb: number;
    estMonthlyCostUsd: number;
    orphanVolumes: number;
    boxes: number;
  };
}

function roundCents(x: number): number {
  return Math.round(x * 100) / 100;
}

function volumeCost(sizeGb: number | null | undefined): number {
  return roundCents((sizeGb ?? 0) * VOLUME_USD_PER_GB_MONTH);
}

type InstanceRow = {
  runId: number;
  provider: string;
  machineId: string | null;
  volumeId: string | null;
  region: string | null;
  state: string;
  createdAt: Date | null;
  runStatus: string | null;
  boxId: string | null;
  boxTemplateId: string | null;
  boxSourceId: string | null;
  snapshotId: string | null;
  snapshotCompletedAt: Date | null;
  checkpointRequestedAt: Date | null;
  lastCheckpointAt: Date | null;
  lastStartedAt: Date | null;
  workerVersion: string | null;
  lastProviderError: string | null;
};

const ACTIVE_BOX_STATES = new Set(["creating", "starting", "running"]);

function checkpointStatus(instance: InstanceRow): "completed" | "pending" | null {
  if (instance.snapshotId && (instance.lastCheckpointAt ?? instance.snapshotCompletedAt)) return "completed";
  if (instance.checkpointRequestedAt) return "pending";
  return null;
}

function redactedProviderError(value: string | null): string | null {
  if (!value) return null;
  // Inventory is terminal-facing, not an error archive. Cap a malformed/raw
  // payload after applying the Box error redactor so neither secrets nor an
  // unexpectedly huge API response reach CLI/JSON consumers.
  const redacted = redactBoxErrorText(value)
    // Database access is never a legitimate Box error detail, but redact it
    // defensively in case an upstream/proxy echoes a server environment value.
    .replace(/\bDATABASE_URL\s*([:=])\s*[^\s,;"']+/gi, "DATABASE_URL$1[redacted]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted-url]");
  return redacted.length > 512 ? `${redacted.slice(0, 509)}...` : redacted;
}

export async function collectRunnerInventory(flyClient?: FlyClient): Promise<RunnerInventory> {
  const now = Date.now();

  // No injected client → try to build one. If Fly creds are absent, degrade to
  // empty live-resource lists so the command still reports the DB-side mapping.
  let client: FlyClient | undefined = flyClient;
  if (!client) {
    try {
      client = makeFlyClient();
    } catch {
      client = undefined;
    }
  }

  let machines: FlyMachine[] = [];
  let volumes: FlyVolume[] = [];
  if (client) {
    try {
      machines = await client.listMachines();
    } catch {
      machines = [];
    }
    try {
      volumes = await client.listVolumes();
    } catch {
      volumes = [];
    }
  }

  const instances: InstanceRow[] = await db
    .select({
      runId: runnerInstances.runId,
      provider: runnerInstances.provider,
      machineId: runnerInstances.machineId,
      volumeId: runnerInstances.volumeId,
      region: runnerInstances.region,
      state: runnerInstances.state,
      createdAt: runnerInstances.createdAt,
      lastStartedAt: runnerInstances.lastStartedAt,
      boxId: runnerInstances.boxId,
      boxTemplateId: runnerInstances.boxTemplateId,
      boxSourceId: runnerInstances.boxSourceId,
      snapshotId: runnerInstances.snapshotId,
      snapshotCompletedAt: runnerInstances.snapshotCompletedAt,
      checkpointRequestedAt: runnerInstances.checkpointRequestedAt,
      lastCheckpointAt: runnerInstances.lastCheckpointAt,
      workerVersion: runnerInstances.workerVersion,
      lastProviderError: runnerInstances.lastProviderError,
      runStatus: agentSessions.status,
    })
    .from(runnerInstances)
    .leftJoin(agentSessions, eq(runnerInstances.runId, agentSessions.id));

  const machineById = new Map(machines.map((m) => [m.id, m]));
  const instanceByVolume = new Map<string, InstanceRow>();
  for (const inst of instances) {
    if (inst.volumeId) instanceByVolume.set(inst.volumeId, inst);
  }

  // A volume is claimed (not orphaned) if any non-"gone" runner_instances row
  // references it — this mirrors the reaper's "leaked volume" predicate.
  // Precompute the set of claimed volumeIds once (O(instances)) so the per-volume
  // orphan check below stays O(1) instead of O(instances * volumes).
  const claimedVolumeIds = new Set<string>();
  for (const i of instances) {
    if (i.volumeId && i.state !== "gone") claimedVolumeIds.add(i.volumeId);
  }

  const rows: RunnerInventoryRow[] = [];

  // 1) One row per live Fly volume, enriched with its DB mapping + machine state.
  for (const vol of volumes) {
    const mapping = instanceByVolume.get(vol.id);
    const machineId = vol.attachedMachineId ?? mapping?.machineId ?? null;
    const machineState = machineId ? machineById.get(machineId)?.state ?? null : null;
    const createdAt = mapping?.createdAt ?? vol.createdAt ?? null;
    // Mirror the reaper's isReapableVolume name guard (lib/runner/fly.ts): only a
    // `vol_run_*` volume we created is a reap candidate, so the persistent
    // prewarm_seed volume (named without that prefix) is never misreported as an
    // orphan even though it is unattached and unclaimed.
    const orphan =
      !!vol.name &&
      vol.name.startsWith("vol_run_") &&
      !vol.attachedMachineId &&
      !claimedVolumeIds.has(vol.id);
    rows.push({
      provider: "fly",
      runId: mapping?.runId ?? null,
      machineId,
      machineState,
      volumeId: vol.id,
      volumeName: vol.name ?? null,
      volumeState: vol.state ?? null,
      sizeGb: vol.sizeGb ?? null,
      region: vol.region ?? mapping?.region ?? null,
      runStatus: mapping?.runStatus ?? null,
      ageMs: createdAt ? now - createdAt.getTime() : null,
      orphan,
      estMonthlyCostUsd: volumeCost(vol.sizeGb),
      runnerState: mapping?.state ?? null,
      boxId: null,
      boxState: null,
      boxTemplateId: null,
      boxSourceId: null,
      workerVersion: null,
      snapshotId: null,
      checkpointStatus: null,
      checkpointAgeMs: null,
      activeDurationMs: null,
      lastProviderError: null,
    });
  }

  // 2) Stale mappings: runner_instances rows whose volumeId is set but the volume
  // is already gone from Fly. Surface them (machine/volume state null) so an
  // operator can see leftover DB rows. Not orphans — there is no volume to reap.
  const liveVolumeIds = new Set(volumes.map((v) => v.id));
  for (const inst of instances) {
    if (!inst.volumeId || liveVolumeIds.has(inst.volumeId)) continue;
    rows.push({
      provider: "fly",
      runId: inst.runId,
      machineId: inst.machineId,
      machineState: null,
      volumeId: inst.volumeId,
      volumeName: null,
      volumeState: null,
      sizeGb: null,
      region: inst.region,
      runStatus: inst.runStatus,
      ageMs: inst.createdAt ? now - inst.createdAt.getTime() : null,
      orphan: false,
      estMonthlyCostUsd: 0,
      runnerState: inst.state,
      boxId: null,
      boxState: null,
      boxTemplateId: null,
      boxSourceId: null,
      workerVersion: null,
      snapshotId: null,
      checkpointStatus: null,
      checkpointAgeMs: null,
      activeDurationMs: null,
      lastProviderError: null,
    });
  }

  // 3) Every persisted Box mapping becomes one inventory row. There is no Box
  // client call here by design: an archived Box is a durable checkpoint, not a
  // resource an inventory page should resume or otherwise mutate.
  for (const inst of instances) {
    if (inst.provider !== "box" || !inst.boxId) continue;
    const checkpointAt = inst.lastCheckpointAt ?? inst.snapshotCompletedAt;
    const activeSince = inst.lastStartedAt ?? inst.createdAt;
    rows.push({
      provider: "box",
      runId: inst.runId,
      machineId: null,
      machineState: null,
      volumeId: null,
      volumeName: null,
      volumeState: null,
      sizeGb: null,
      region: null,
      runStatus: inst.runStatus,
      ageMs: inst.createdAt ? now - inst.createdAt.getTime() : null,
      orphan: false,
      estMonthlyCostUsd: 0,
      runnerState: inst.state,
      boxId: inst.boxId,
      boxState: inst.state,
      boxTemplateId: inst.boxTemplateId,
      boxSourceId: inst.boxSourceId,
      workerVersion: inst.workerVersion,
      snapshotId: inst.snapshotId,
      checkpointStatus: checkpointStatus(inst),
      checkpointAgeMs: checkpointAt ? now - checkpointAt.getTime() : null,
      activeDurationMs:
        ACTIVE_BOX_STATES.has(inst.state) && activeSince ? now - activeSince.getTime() : null,
      lastProviderError: redactedProviderError(inst.lastProviderError),
    });
  }

  const totalGb = rows.reduce((sum, r) => sum + (r.sizeGb ?? 0), 0);
  const estMonthlyCostUsd = roundCents(rows.reduce((sum, r) => sum + r.estMonthlyCostUsd, 0));
  const orphanVolumes = rows.filter((r) => r.orphan).length;
  const boxes = rows.filter((r) => r.provider === "box").length;

  return {
    rows,
    totals: {
      machines: machines.length,
      volumes: volumes.length,
      totalGb,
      estMonthlyCostUsd,
      orphanVolumes,
      boxes,
    },
  };
}
