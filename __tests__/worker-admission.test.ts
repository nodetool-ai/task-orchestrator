// __tests__/worker-admission.test.ts
// Per-worker resource caps + the memory-aware admission gate (lib/run-dispatch).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cpus } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get } from "../lib/runs";
import {
  admissionDecision,
  buildWorkerLimits,
  dispatchRun,
  __resetHostInfoCache,
} from "../lib/run-dispatch";

const MB = 1024 * 1024;

// Snapshot + restore the env knobs each test touches.
const KNOBS = [
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_ADMISSION_ENABLED",
  "TASK_ORCH_WORKER_MEMORY_MB",
  "TASK_ORCH_WORKER_MEMORY_SWAP_MB",
  "TASK_ORCH_WORKER_MEMORY_RESERVATION_MB",
  "TASK_ORCH_WORKER_CPUS",
  "TASK_ORCH_WORKER_PIDS_LIMIT",
];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  __resetHostInfoCache();
});

describe("admissionDecision (pure)", () => {
  const base = { capMB: 3072, reserveMB: 2048, maxWorkers: 0, memTotalMB: 7936, memAvailableMB: 5500 };

  it("admits when the host has budget for another worker", () => {
    // reservation: 7936-2048 = 5888 >= 3072 ✓; live floor: 5500-2048 = 3452 >= 3072 ✓
    expect(admissionDecision({ ...base, inFlight: 0 })).toBe("admit");
  });

  it("defers by reservation accounting once in-flight workers exhaust the budget", () => {
    // budget = 7936 - 2048 = 5888; one 3072 worker leaves 2816 < 3072 → defer.
    expect(admissionDecision({ ...base, inFlight: 1 })).toBe("defer");
  });

  it("defers on the live MemAvailable floor even if reservation math would admit", () => {
    // reservation admits (inFlight 0), but live available is nearly gone.
    expect(admissionDecision({ ...base, inFlight: 0, memAvailableMB: 4000 })).toBe("defer");
  });

  it("ignores the live floor when MemAvailable is null (untrusted /proc/meminfo)", () => {
    expect(admissionDecision({ ...base, inFlight: 0, memAvailableMB: null })).toBe("admit");
  });

  it("defers on the max-workers backstop regardless of memory", () => {
    expect(
      admissionDecision({ ...base, inFlight: 2, maxWorkers: 2, memAvailableMB: 99999, memTotalMB: 99999 })
    ).toBe("defer");
  });

  it("returns never-fits when one worker's cap exceeds the whole budget", () => {
    expect(admissionDecision({ ...base, capMB: 9000, inFlight: 0 })).toBe("never-fits");
  });

  it("is a no-op (admit) when no memory cap and no worker cap are configured", () => {
    expect(
      admissionDecision({ capMB: 0, reserveMB: 0, maxWorkers: 0, inFlight: 99, memTotalMB: 100, memAvailableMB: 1 })
    ).toBe("admit");
  });
});

describe("buildWorkerLimits (env → HostConfig)", () => {
  it("returns {} when nothing is configured (unlimited, today's behavior)", () => {
    expect(buildWorkerLimits()).toEqual({});
  });

  it("sets Memory and defaults MemorySwap equal to Memory (swap disabled)", () => {
    process.env.TASK_ORCH_WORKER_MEMORY_MB = "3072";
    const l = buildWorkerLimits();
    expect(l.Memory).toBe(3072 * MB);
    expect(l.MemorySwap).toBe(3072 * MB); // equal → no swap
  });

  it("raises a too-small MemorySwap up to Memory (Docker requires swap >= mem)", () => {
    process.env.TASK_ORCH_WORKER_MEMORY_MB = "3072";
    process.env.TASK_ORCH_WORKER_MEMORY_SWAP_MB = "1024";
    expect(buildWorkerLimits().MemorySwap).toBe(3072 * MB);
  });

  it("clamps MemoryReservation to at most Memory", () => {
    process.env.TASK_ORCH_WORKER_MEMORY_MB = "2048";
    process.env.TASK_ORCH_WORKER_MEMORY_RESERVATION_MB = "4096";
    expect(buildWorkerLimits().MemoryReservation).toBe(2048 * MB);
  });

  it("sets NanoCpus clamped to the host CPU count, plus PidsLimit", () => {
    process.env.TASK_ORCH_WORKER_CPUS = "2";
    process.env.TASK_ORCH_WORKER_PIDS_LIMIT = "512";
    const l = buildWorkerLimits();
    expect(l.NanoCpus).toBe(Math.floor(Math.min(2, cpus().length || 1) * 1e9));
    expect(l.PidsLimit).toBe(512);
  });

  it("clamps NanoCpus down to the host CPU count for an over-large request", () => {
    process.env.TASK_ORCH_WORKER_CPUS = "1000";
    expect(buildWorkerLimits().NanoCpus).toBe((cpus().length || 1) * 1e9);
  });
});

describe("dispatchRun admission integration", () => {
  it("defers to 'pending' without spawning when the gate says defer", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(run.id, { spawn, admit: () => "defer" });
    expect(result).toBe("deferred");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    expect(row.status).toBe("pending");
    expect(row.workerScope).toBeNull();
  });

  it("fails the run (never-fits) without spawning", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 1);
    const result = await dispatchRun(run.id, { spawn, admit: () => "never-fits" });
    expect(result).toBe("spawn-failed");
    expect(spawn).not.toHaveBeenCalled();
    const row = (await get(run.id))!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/insufficient host memory/i);
  });

  it("spawns normally when the gate admits", async () => {
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 4242);
    const result = await dispatchRun(run.id, { spawn, admit: () => "admit" });
    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    const row = (await get(run.id))!;
    expect(row.status).toBe("preparing");
    expect(row.workerPid).toBe(4242);
  });

  it("stamps a fresh pending-episode heartbeat when deferring a non-pending run, but not on re-defer", async () => {
    // Regression: the MAX_DEFER bound must measure time-in-pending, not time since
    // creation — else an old orphan re-dispatched + deferred is failed instantly.
    process.env.TASK_ORCH_WORKER_IMAGE = "worker:test";
    const run = await create({ goal: "<implement>", defer: true });
    // Simulate an orphaned, resumable run: a lease status with a STALE heartbeat
    // and a released claim (as reconcileOrphanedRuns leaves it before re-dispatch).
    const old = new Date(Date.now() - 60 * 60_000);
    await db
      .update(agentSessions)
      .set({ status: "running", heartbeatAt: old, workerScope: null })
      .where(eq(agentSessions.id, run.id));

    // First defer: running → pending stamps a FRESH episode start.
    expect(await dispatchRun(run.id, { spawn: () => 1, admit: () => "defer" })).toBe("deferred");
    const afterFirst = (await get(run.id))!;
    expect(afterFirst.status).toBe("pending");
    expect(afterFirst.heartbeatAt!.getTime()).toBeGreaterThan(old.getTime());
    const episodeStart = afterFirst.heartbeatAt!.getTime();

    // Second defer while ALREADY pending: must NOT reset the episode clock.
    expect(await dispatchRun(run.id, { spawn: () => 1, admit: () => "defer" })).toBe("deferred");
    const afterSecond = (await get(run.id))!;
    expect(afterSecond.heartbeatAt!.getTime()).toBe(episodeStart);
  });

  it("skips the gate entirely off the containerized path (no WORKER_IMAGE)", async () => {
    // admit would defer, but admissionEnabled() is false, so it must not be called.
    const run = await create({ goal: "<implement>", defer: true });
    const admit = vi.fn(() => "defer" as const);
    const result = await dispatchRun(run.id, { spawn: () => 7, admit });
    expect(result).toBe("spawned");
    expect(admit).not.toHaveBeenCalled();
  });
});
