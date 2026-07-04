import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import { FlyRunnerProvider, isEligibleForLifecycleAction } from "../lib/runner/fly";
import type { FlyClient, FlyMachine, FlyMachineConfig } from "../lib/runner/fly-client";

type FakeOptions = {
  machines?: FlyMachine[];
  getMachine?: FlyMachine | null;
  /** Volume ids whose createMachine call should throw (simulates a dead volume). */
  createMachineFailsForVolume?: Set<string>;
  /** Machine ids whose stopMachine call should throw. */
  stopMachineFailsFor?: Set<string>;
};

function fakeFlyClient(calls: string[] = [], opts: FakeOptions = {}): FlyClient {
  let machineSeq = 0;
  let volumeSeq = 0;
  const machines = new Map((opts.machines ?? []).map((m) => [m.id, m]));
  return {
    async createVolume(input: { name: string }) {
      calls.push(`createVolume:${input.name}`);
      volumeSeq += 1;
      return { id: `v${volumeSeq}`, region: "ams" };
    },
    async destroyVolume(id: string) {
      calls.push(`destroyVolume:${id}`);
    },
    async createMachine(input: { name: string; region: string; config: FlyMachineConfig }) {
      const volumeId = input.config.mounts[0]?.volume;
      calls.push("createMachine");
      if (volumeId && opts.createMachineFailsForVolume?.has(volumeId)) {
        throw new Error(`fake: volume ${volumeId} not found`);
      }
      machineSeq += 1;
      const id = machineSeq === 1 ? "m1" : `m${machineSeq}`;
      const machine = { id, state: "created", region: input.region };
      machines.set(id, machine);
      calls.push(`createMachineVolume:${volumeId}`);
      return machine;
    },
    async getMachine(id: string) {
      calls.push(`getMachine:${id}`);
      if (opts.getMachine !== undefined) return opts.getMachine;
      return machines.get(id) ?? null;
    },
    async startMachine(id: string) {
      calls.push(`startMachine:${id}`);
    },
    async suspendMachine(id: string) {
      calls.push(`suspendMachine:${id}`);
    },
    async stopMachine(id: string) {
      calls.push(`stopMachine:${id}`);
      if (opts.stopMachineFailsFor?.has(id)) {
        throw new Error(`fake: stop rejected for ${id}`);
      }
    },
    async destroyMachine(id: string) {
      calls.push(`destroyMachine:${id}`);
      machines.delete(id);
    },
    async listMachines() {
      calls.push("listMachines");
      return [...machines.values()];
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("FlyRunnerProvider", () => {
  it("provisions a volume + machine and records the mapping", async () => {
    const calls: string[] = [];
    const provider = new FlyRunnerProvider(fakeFlyClient(calls));
    const run = await create({ goal: "<implement>", defer: true });

    const ref = await provider.create({ runId: run.id, scope: `run-${run.id}-x` });

    expect(ref?.provider).toBe("fly");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.volumeId).toBeTruthy();
    expect(row.machineId).toBe(ref!.handle);
    expect(calls.slice(0, 3)).toEqual([`createVolume:vol_run_${run.id}`, "createMachine", "createMachineVolume:v1"]);
    // Fly volume names allow only [a-z0-9_], max 30 chars — reject hyphens etc.
    const volName = `vol_run_${run.id}`;
    expect(volName).toMatch(/^[a-z0-9_]{1,30}$/);
  });

  it("fails a leased run whose machine has vanished", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running", workerScope: "m-gone", heartbeatAt: new Date(Date.now() - 60_000) })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m-gone",
      volumeId: "v1",
      region: "ams",
      state: "running",
    });

    const provider = new FlyRunnerProvider(fakeFlyClient([], { machines: [] }));
    await provider.sweep();

    expect((await get(run.id))?.status).toBe("failed");
  });

  it("resumes a suspended machine with startMachine", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m1",
      volumeId: "v1",
      region: "ams",
      state: "suspended",
    });
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, { getMachine: { id: "m1", state: "suspended", region: "ams" } })
    );

    const ref = await provider.resume(run.id);

    expect(ref?.handle).toBe("m1");
    expect(calls).toContain("startMachine:m1");
    expect(calls).not.toContain("createMachine");
  });

  it("cold-recovers by creating a new machine on the same volume", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m-old",
      volumeId: "v-stable",
      region: "ams",
      state: "gone",
    });
    const provider = new FlyRunnerProvider(fakeFlyClient(calls, { getMachine: null }));

    const ref = await provider.resume(run.id);

    expect(ref?.handle).toBe("m1");
    expect(calls).toContain("createMachine");
    expect(calls).toContain("createMachineVolume:v-stable");
  });

  it("suspends an idle running machine during sweep", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions)
      .set({ status: "idle", workerScope: "m1", heartbeatAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m1",
      volumeId: "v1",
      region: "ams",
      state: "running",
      lastStartedAt: new Date(Date.now() - 2 * 3600_000),
    });

    const provider = new FlyRunnerProvider(fakeFlyClient(calls, { machines: [{ id: "m1", state: "started", region: "ams" }] }));
    await provider.sweep();

    expect(calls).toContain("suspendMachine:m1");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("suspended");
    expect((await get(run.id))?.workerScope).toBeNull();
  });

  it("defers dispatch when TASK_ORCH_MAX_MACHINES would be exceeded", async () => {
    vi.stubEnv("TASK_ORCH_RUNNER", "fly");
    vi.stubEnv("TASK_ORCH_MAX_MACHINES", "1");
    const first = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: first.id,
      machineId: "m1",
      volumeId: "v1",
      region: "ams",
      state: "running",
    });
    const second = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 1);

    await expect(dispatchRun(second.id, { spawn })).resolves.toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    expect((await get(second.id))?.status).toBe("pending");
  });

  it("resume() provisions a fresh machine instead of returning a destroyed one", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m-dead",
      volumeId: "v-stable",
      region: "ams",
      state: "running",
    });
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, { getMachine: { id: "m-dead", state: "destroyed", region: "ams" } })
    );

    const ref = await provider.resume(run.id);

    // Never restart/return the destroyed machine as a live handle.
    expect(calls).not.toContain("startMachine:m-dead");
    expect(ref?.handle).not.toBe("m-dead");
    // Instead it cold-recovers a fresh machine from the still-usable volume.
    expect(calls).toContain("createMachineVolume:v-stable");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.machineId).toBe(ref!.handle);
    expect(row.volumeId).toBe("v-stable");
  });

  it("resume() clears the stale mapping when the volume itself is also gone", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: "m-dead",
      volumeId: "v-dead",
      region: "ams",
      state: "running",
    });
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, {
        getMachine: { id: "m-dead", state: "destroyed", region: "ams" },
        createMachineFailsForVolume: new Set(["v-dead"]),
      })
    );

    const ref = await provider.resume(run.id);

    expect(ref).toBeNull();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.machineId).toBeNull();
    expect(row.volumeId).toBeNull();
    expect(row.state).toBe("gone");
  });

  it("sweep continues past a row whose lifecycle action throws", async () => {
    vi.stubEnv("TASK_ORCH_RUNNER_SUSPEND_MS", "0");
    const calls: string[] = [];
    const bad = await create({ goal: "<implement>", defer: true });
    const ok = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions).set({ status: "completed" }).where(eq(agentSessions.id, bad.id));
    await db.update(agentSessions).set({ status: "completed" }).where(eq(agentSessions.id, ok.id));
    await db.insert(runnerInstances).values({
      runId: bad.id,
      machineId: "m-bad",
      volumeId: "v-bad",
      region: "ams",
      state: "running",
    });
    await db.insert(runnerInstances).values({
      runId: ok.id,
      machineId: "m-ok",
      volumeId: "v-ok",
      region: "ams",
      state: "running",
    });

    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, {
        machines: [
          { id: "m-bad", state: "started", region: "ams" },
          { id: "m-ok", state: "started", region: "ams" },
        ],
        stopMachineFailsFor: new Set(["m-bad"]),
      })
    );

    await expect(provider.sweep()).resolves.toBeUndefined();

    expect(calls).toContain("stopMachine:m-bad");
    expect(calls).toContain("stopMachine:m-ok");
    const [okRow] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, ok.id));
    expect(okRow.state).toBe("stopped");
  });

  // M15: the pre-execution re-check (applyLifecycle, right before suspendMachine/
  // stopMachine) is driven by this pure predicate — unit-test it directly so the
  // "row went active between the sweep's decision and its execution" case is
  // covered deterministically, without racing real timing against a live sweep.
  describe("isEligibleForLifecycleAction (M15 pre-execution re-check)", () => {
    it("is eligible when idle with no live claim", () => {
      expect(
        isEligibleForLifecycleAction({ status: "idle", workerScope: null, heartbeatAt: null })
      ).toBe(true);
    });

    it("skips (not eligible) when the row went active — a lease status by execution time", () => {
      expect(
        isEligibleForLifecycleAction({ status: "running", workerScope: "m1", heartbeatAt: new Date() })
      ).toBe(false);
    });

    it("skips (not eligible) when a chat worker re-claimed with a fresh heartbeat at 'idle'", () => {
      expect(
        isEligibleForLifecycleAction({ status: "idle", workerScope: "m1", heartbeatAt: new Date() })
      ).toBe(false);
    });

    it("is eligible again once a held claim's heartbeat has gone stale", () => {
      expect(
        isEligibleForLifecycleAction({
          status: "idle",
          workerScope: "m1",
          heartbeatAt: new Date(Date.now() - 6 * 60_000),
        })
      ).toBe(true);
    });
  });

  it("stop() destroys the machine's volume and clears the mapping", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    // Unique ids: runnerInstances.machineId isn't unique across rows and other
    // tests in this file reuse "m1"/"v1", so a shared id could match a stale row.
    const machineId = `m-stop-${run.id}`;
    const volumeId = `v-stop-${run.id}`;
    await db.update(agentSessions)
      .set({ status: "running", workerScope: machineId })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId,
      volumeId,
      region: "ams",
      state: "running",
    });
    const provider = new FlyRunnerProvider(fakeFlyClient(calls));

    await provider.stop(machineId);

    expect(calls).toContain(`destroyMachine:${machineId}`);
    expect(calls).toContain(`destroyVolume:${volumeId}`);
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
    expect(row.machineId).toBeNull();
    expect(row.volumeId).toBeNull();
  });
});
