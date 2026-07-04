import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import { FlyRunnerProvider } from "../lib/runner/fly";
import type { FlyClient, FlyMachine, FlyMachineConfig } from "../lib/runner/fly-client";

type FakeOptions = { machines?: FlyMachine[]; getMachine?: FlyMachine | null };

function fakeFlyClient(calls: string[] = [], opts: FakeOptions = {}): FlyClient {
  let machineSeq = 0;
  let volumeSeq = 0;
  const machines = new Map((opts.machines ?? []).map((m) => [m.id, m]));
  return {
    async createVolume() {
      calls.push("createVolume");
      volumeSeq += 1;
      return { id: `v${volumeSeq}`, region: "ams" };
    },
    async destroyVolume(id: string) {
      calls.push(`destroyVolume:${id}`);
    },
    async createMachine(input: { name: string; region: string; config: FlyMachineConfig }) {
      calls.push("createMachine");
      machineSeq += 1;
      const id = machineSeq === 1 ? "m1" : `m${machineSeq}`;
      const machine = { id, state: "created", region: input.region };
      machines.set(id, machine);
      calls.push(`createMachineVolume:${input.config.mounts[0]?.volume}`);
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
    expect(calls.slice(0, 3)).toEqual(["createVolume", "createMachine", "createMachineVolume:v1"]);
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
});
