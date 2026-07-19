// __tests__/fly-machine-resources.test.ts
//
// Incident (run 59, 2026-07-06): TASK_ORCH_FLY_MEMORY_MB was bumped to 8192 to
// fix OOM-killed workers, but TASK_ORCH_FLY_CPUS stayed at its old default of 2.
// Fly's shared-cpu machines cap memory at 2048MB per vCPU, so 8192MB/2 vCPU
// silently failed createMachine — surfacing only as the opaque "spawn returned
// no pid" dispatch error, with no clue that the resource *ratio* was invalid.
// buildFlyMachineConfig now validates the ratio itself so a misconfiguration
// fails loudly, at config-build time, with the actual numbers in the message.
import { afterEach, describe, expect, it } from "vitest";
import { buildFlyMachineConfig } from "../lib/runner/fly";

const KNOBS = ["TASK_ORCH_FLY_CPUS", "TASK_ORCH_FLY_MEMORY_MB"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
});

describe("buildFlyMachineConfig resource validation", () => {
  it("defaults to a valid shared-cpu ratio (4 vCPU / 4096MB)", async () => {
    const config = await buildFlyMachineConfig(1, "vol_run_1");
    expect(config.guest.cpu_kind).toBe("shared");
    expect(config.guest.cpus).toBe(4);
    expect(config.guest.memory_mb).toBe(4096);
  });

  it("accepts the incident's intended fix: 8192MB across the new 4 vCPU default", async () => {
    process.env.TASK_ORCH_FLY_MEMORY_MB = "8192";
    const config = await buildFlyMachineConfig(1, "vol_run_1");
    expect(config.guest.cpus).toBe(4);
    expect(config.guest.memory_mb).toBe(8192);
  });

  it("throws the exact incident combination: 8192MB over 2 vCPU (max is 4096MB)", async () => {
    process.env.TASK_ORCH_FLY_CPUS = "2";
    process.env.TASK_ORCH_FLY_MEMORY_MB = "8192";
    await expect(buildFlyMachineConfig(1, "vol_run_1")).rejects.toThrow(/8192MB.*2 vCPU|shared-cpu allows/i);
  });

  it("throws when memory is below the shared-cpu minimum (256MB per vCPU)", async () => {
    process.env.TASK_ORCH_FLY_CPUS = "2";
    process.env.TASK_ORCH_FLY_MEMORY_MB = "128";
    await expect(buildFlyMachineConfig(1, "vol_run_1")).rejects.toThrow(/shared-cpu allows/i);
  });

  it("allows a valid explicit combination at the upper bound (2048MB * cpus)", async () => {
    process.env.TASK_ORCH_FLY_CPUS = "8";
    process.env.TASK_ORCH_FLY_MEMORY_MB = "16384";
    const config = await buildFlyMachineConfig(1, "vol_run_1");
    expect(config.guest.cpus).toBe(8);
    expect(config.guest.memory_mb).toBe(16384);
  });
});
