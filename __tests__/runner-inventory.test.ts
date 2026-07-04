import { afterEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db";
import { runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { collectRunnerInventory, VOLUME_USD_PER_GB_MONTH } from "../lib/runner/inventory";
import type { FlyClient, FlyMachine, FlyVolume } from "../lib/runner/fly-client";

// Minimal fake: only listMachines/listVolumes carry real returns; the rest are
// no-op stubs the inventory collector never touches.
function fakeFlyClient(machines: FlyMachine[], volumes: FlyVolume[]): FlyClient {
  return {
    async listMachines() {
      return machines;
    },
    async listVolumes() {
      return volumes;
    },
    async createVolume() {
      throw new Error("not implemented");
    },
    async destroyVolume() {
      throw new Error("not implemented");
    },
    async createMachine() {
      throw new Error("not implemented");
    },
    async getMachine() {
      return null;
    },
    async startMachine() {},
    async suspendMachine() {},
    async stopMachine() {},
    async destroyMachine() {},
  };
}

describe("collectRunnerInventory", () => {
  const runIds: number[] = [];

  afterEach(async () => {
    if (runIds.length) {
      await db.delete(runnerInstances).where(inArray(runnerInstances.runId, runIds));
    }
    runIds.length = 0;
  });

  it("reports an attached, live machine+volume as non-orphan with correct cost", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    runIds.push(run.id);
    const machineId = `m_${run.id}`;
    const volumeId = `vol_${run.id}`;
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "fly",
      flyApp: "app",
      machineId,
      volumeId,
      region: "ams",
      state: "running",
    });

    const machines: FlyMachine[] = [{ id: machineId, state: "started", region: "ams" }];
    const volumes: FlyVolume[] = [
      { id: volumeId, region: "ams", name: "vol_run_x", state: "created", sizeGb: 10, attachedMachineId: machineId },
    ];

    const inv = await collectRunnerInventory(fakeFlyClient(machines, volumes));
    const row = inv.rows.find((r) => r.volumeId === volumeId);
    expect(row).toBeDefined();
    expect(row!.runId).toBe(run.id);
    expect(row!.machineState).toBe("started");
    expect(row!.orphan).toBe(false);
    expect(row!.estMonthlyCostUsd).toBe(10 * VOLUME_USD_PER_GB_MONTH);
    expect(row!.runStatus).toBeTruthy();
  });

  it("flags an unattached, unclaimed volume as an orphan and counts it", async () => {
    const volumeId = `vol_orphan_${Date.now()}`;
    const volumes: FlyVolume[] = [
      { id: volumeId, region: "ams", name: "vol_run_leak", state: "created", sizeGb: 5, attachedMachineId: null },
    ];

    const inv = await collectRunnerInventory(fakeFlyClient([], volumes));
    const row = inv.rows.find((r) => r.volumeId === volumeId);
    expect(row).toBeDefined();
    expect(row!.orphan).toBe(true);
    expect(row!.runId).toBeNull();
    expect(inv.totals.orphanVolumes).toBeGreaterThanOrEqual(1);
    expect(inv.rows.filter((r) => r.volumeId === volumeId && r.orphan)).toHaveLength(1);
  });

  it("computes totals across machines and volumes", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    runIds.push(run.id);
    const machineId = `m_tot_${run.id}`;
    const attachedVol = `vol_tot_${run.id}`;
    const orphanVol = `vol_tot_orphan_${run.id}`;
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "fly",
      machineId,
      volumeId: attachedVol,
      region: "ams",
      state: "running",
    });

    const machines: FlyMachine[] = [{ id: machineId, state: "started", region: "ams" }];
    const volumes: FlyVolume[] = [
      { id: attachedVol, region: "ams", name: "vol_run_a", sizeGb: 10, attachedMachineId: machineId },
      { id: orphanVol, region: "ams", name: "vol_run_b", sizeGb: 20, attachedMachineId: null },
    ];

    const inv = await collectRunnerInventory(fakeFlyClient(machines, volumes));
    // Scope assertions to our seeded rows (other rows may exist from live DB state).
    const ours = inv.rows.filter((r) => r.volumeId === attachedVol || r.volumeId === orphanVol);
    const gb = ours.reduce((s, r) => s + (r.sizeGb ?? 0), 0);
    const cost = ours.reduce((s, r) => s + r.estMonthlyCostUsd, 0);
    expect(gb).toBe(30);
    expect(cost).toBeCloseTo(30 * VOLUME_USD_PER_GB_MONTH, 5);
    expect(inv.totals.machines).toBe(1);
    expect(inv.totals.volumes).toBe(2);
  });
});
