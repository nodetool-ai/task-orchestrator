import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create, get } from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";
import { FlyRunnerProvider, isEligibleForLifecycleAction, isReapableVolume } from "../lib/runner/fly";
import type { FlyClient, FlyMachine, FlyMachineConfig, FlyVolume } from "../lib/runner/fly-client";

type FakeOptions = {
  machines?: FlyMachine[];
  getMachine?: FlyMachine | null;
  /** Volume ids whose createMachine call should throw (simulates a dead volume). */
  createMachineFailsForVolume?: Set<string>;
  /** Machine ids whose stopMachine call should throw. */
  stopMachineFailsFor?: Set<string>;
  /** Volumes returned by listVolumes() (orphan-reaper tests). */
  volumes?: FlyVolume[];
  /** Volume ids whose destroyVolume call should throw (reaper failure tests). */
  destroyVolumeFailsFor?: Set<string>;
};

function fakeFlyClient(calls: string[] = [], opts: FakeOptions = {}): FlyClient {
  let machineSeq = 0;
  let volumeSeq = 0;
  const machines = new Map((opts.machines ?? []).map((m) => [m.id, m]));
  const volumes = new Map((opts.volumes ?? []).map((v) => [v.id, v]));
  return {
    async createVolume(input: { name: string }) {
      calls.push(`createVolume:${input.name}`);
      volumeSeq += 1;
      return { id: `v${volumeSeq}`, region: "ams" };
    },
    async destroyVolume(id: string) {
      calls.push(`destroyVolume:${id}`);
      if (opts.destroyVolumeFailsFor?.has(id)) {
        throw new Error(`fake: destroyVolume rejected for ${id}`);
      }
      volumes.delete(id);
    },
    async listVolumes() {
      calls.push("listVolumes");
      return [...volumes.values()];
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
    // Idle (resumable) rows so SUSPEND_MS=0 drives the stop path this test
    // exercises. A terminal run would instead take the short terminal-window
    // path (suspend within 1h, archive-and-destroy after) — a different action.
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, bad.id));
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, ok.id));
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

  // Task 5: the orphan-volume reaper's guards live in this pure predicate — unit
  // test each guard directly so the "reap a leak but never an in-use volume" rules
  // are covered deterministically.
  describe("isReapableVolume (orphan-volume reaper guards)", () => {
    const OLD = new Date(Date.now() - 60 * 60_000); // 1h old, past the grace window
    const now = Date.now();

    it("is reapable: unattached + old + vol_run_* + unprotected", () => {
      expect(
        isReapableVolume(
          { id: "v1", name: "vol_run_7", attachedMachineId: null, createdAt: OLD },
          new Set(),
          now
        )
      ).toBe(true);
    });

    it("is reapable when createdAt is absent (unknown age → old enough)", () => {
      expect(
        isReapableVolume({ id: "v1", name: "vol_run_7", attachedMachineId: null }, new Set(), now)
      ).toBe(true);
    });

    it("is NOT reapable when a machine is attached", () => {
      expect(
        isReapableVolume(
          { id: "v1", name: "vol_run_7", attachedMachineId: "m1", createdAt: OLD },
          new Set(),
          now
        )
      ).toBe(false);
    });

    it("is NOT reapable when protected by a live runner_instances row", () => {
      expect(
        isReapableVolume(
          { id: "v1", name: "vol_run_7", attachedMachineId: null, createdAt: OLD },
          new Set(["v1"]),
          now
        )
      ).toBe(false);
    });

    it("is NOT reapable when too young (createdAt within the grace window)", () => {
      expect(
        isReapableVolume(
          { id: "v1", name: "vol_run_7", attachedMachineId: null, createdAt: new Date(now - 60_000) },
          new Set(),
          now
        )
      ).toBe(false);
    });

    it("is NOT reapable when the name isn't ours (not vol_run_*)", () => {
      expect(
        isReapableVolume(
          { id: "v1", name: "some_other_vol", attachedMachineId: null, createdAt: OLD },
          new Set(),
          now
        )
      ).toBe(false);
    });

    it("is NOT reapable when the name is missing (unknown provenance)", () => {
      expect(
        isReapableVolume({ id: "v1", attachedMachineId: null, createdAt: OLD }, new Set(), now)
      ).toBe(false);
    });
  });

  it("sweep reaps a leaked volume but spares attached/referenced ones", async () => {
    const calls: string[] = [];
    // A run whose volume is still referenced by a non-gone runner_instances row.
    const live = await create({ goal: "<implement>", defer: true });
    const liveVol = `vol_run_${live.id}`;
    await db.insert(runnerInstances).values({
      runId: live.id,
      machineId: null,
      volumeId: liveVol,
      region: "ams",
      state: "starting",
    });

    const old = new Date(Date.now() - 60 * 60_000);
    const leaked = "vol_run_orphan";
    const attached = "vol_run_attached";
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, {
        machines: [],
        volumes: [
          // Leaked: our naming, unattached, old, no non-gone row → reaped.
          { id: leaked, region: "ams", name: leaked, attachedMachineId: null, createdAt: old },
          // Attached to a machine → spared.
          { id: attached, region: "ams", name: attached, attachedMachineId: "m9", createdAt: old },
          // Referenced by the live runner_instances row above → spared.
          { id: liveVol, region: "ams", name: liveVol, attachedMachineId: null, createdAt: old },
        ],
      })
    );

    await provider.sweep();

    expect(calls).toContain("listVolumes");
    expect(calls).toContain(`destroyVolume:${leaked}`);
    expect(calls).not.toContain(`destroyVolume:${attached}`);
    expect(calls).not.toContain(`destroyVolume:${liveVol}`);
  });

  it("a failed reap destroy leaves the runner_instances mapping intact", async () => {
    const calls: string[] = [];
    // A "gone" row still carrying a stale (reapable) volumeId. The reaper would
    // normally clear volumeId after destroying — but only on a CONFIRMED destroy.
    const run = await create({ goal: "<implement>", defer: true });
    const staleVol = `vol_run_fail_${run.id}`;
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: null,
      volumeId: staleVol,
      region: "ams",
      state: "gone",
    });
    const old = new Date(Date.now() - 60 * 60_000);
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, {
        machines: [],
        volumes: [{ id: staleVol, region: "ams", name: staleVol, attachedMachineId: null, createdAt: old }],
        destroyVolumeFailsFor: new Set([staleVol]),
      })
    );

    await provider.sweep();

    expect(calls).toContain(`destroyVolume:${staleVol}`);
    // Destroy failed → mapping must NOT be cleared, so the next sweep retries.
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.volumeId).toBe(staleVol);
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

  it("archive-and-destroy sweep clears the run's stale SDK resume token", async () => {
    // TERMINAL_MS=0 → any terminal run's running machine takes the archive-and-
    // destroy branch immediately (no 1h window to wait out).
    vi.stubEnv("TASK_ORCH_RUNNER_TERMINAL_MS", "0");
    const run = await create({ goal: "<implement>", defer: true });
    const machineId = `m-ad-${run.id}`;
    const volumeId = `v-ad-${run.id}`;
    // Terminal run carrying a stored SDK resume token that points at the
    // transcript living on this volume.
    await db.update(agentSessions)
      .set({ status: "completed", sdkSessionId: "sdk-ad" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId,
      volumeId,
      region: "ams",
      state: "running",
    });
    const provider = new FlyRunnerProvider(
      fakeFlyClient([], { machines: [{ id: machineId, state: "started", region: "ams" }] })
    );

    await provider.sweep();

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
    expect(row.volumeId).toBeNull();
    // Volume (and its transcript) destroyed → the dangling resume token is cleared.
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.sdkSessionId).toBeNull();
  });

  it("reapOrphanVolumes clears the run's SDK resume token after destroying its volume", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ sdkSessionId: "sdk-reap" })
      .where(eq(agentSessions.id, run.id));
    // A "gone" row still carrying a stale (reapable) volumeId — unprotected, so
    // the reaper destroys the volume and runs its bookkeeping against this run.
    const staleVol = `vol_run_reap_${run.id}`;
    await db.insert(runnerInstances).values({
      runId: run.id,
      machineId: null,
      volumeId: staleVol,
      region: "ams",
      state: "gone",
    });
    const old = new Date(Date.now() - 60 * 60_000);
    const provider = new FlyRunnerProvider(
      fakeFlyClient(calls, {
        machines: [],
        volumes: [{ id: staleVol, region: "ams", name: staleVol, attachedMachineId: null, createdAt: old }],
      })
    );

    await provider.sweep();

    expect(calls).toContain(`destroyVolume:${staleVol}`);
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.volumeId).toBeNull();
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.sdkSessionId).toBeNull();
  });

  it("stop() clears the run's SDK resume token when it destroys the volume", async () => {
    const calls: string[] = [];
    const run = await create({ goal: "<implement>", defer: true });
    const machineId = `m-stopsdk-${run.id}`;
    const volumeId = `v-stopsdk-${run.id}`;
    await db.update(agentSessions)
      .set({ status: "running", workerScope: machineId, sdkSessionId: "sdk-stop" })
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

    expect(calls).toContain(`destroyVolume:${volumeId}`);
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.sdkSessionId).toBeNull();
  });
});
