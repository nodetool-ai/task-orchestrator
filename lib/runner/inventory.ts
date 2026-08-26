// lib/runner/inventory.ts
// Runner cost/inventory view: reconcile live Fly Machines + Volumes against
// the persisted runner_instances mappings. Operators can see what belongs to a
// run, how old it is, roughly what it costs, and which Fly volumes have leaked
// (orphans).

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { runnerInstances, agentSessions } from "@/db/schema";
import { makeFlyClient, type FlyClient, type FlyMachine, type FlyVolume } from "./fly-client";

/** Fly volume storage list price. This is an ESTIMATE for visibility only —
 *  actual billing depends on region and any negotiated pricing. */
export const VOLUME_USD_PER_GB_MONTH = 0.15;

export interface RunnerInventoryRow {
  provider: "fly";
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
}

export interface RunnerInventory {
  rows: RunnerInventoryRow[];
  totals: {
    machines: number;
    volumes: number;
    totalGb: number;
    estMonthlyCostUsd: number;
    orphanVolumes: number;
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
  lastStartedAt: Date | null;
};

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
    });
  }

  const totalGb = rows.reduce((sum, r) => sum + (r.sizeGb ?? 0), 0);
  const estMonthlyCostUsd = roundCents(rows.reduce((sum, r) => sum + r.estMonthlyCostUsd, 0));
  const orphanVolumes = rows.filter((r) => r.orphan).length;

  return {
    rows,
    totals: {
      machines: machines.length,
      volumes: volumes.length,
      totalGb,
      estMonthlyCostUsd,
      orphanVolumes,
    },
  };
}
