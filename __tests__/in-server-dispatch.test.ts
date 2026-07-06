// __tests__/in-server-dispatch.test.ts
//
// Repo-less runs (cwd_strategy="none" — plan executors, chat, planners) execute
// IN THE ORCHESTRATOR PROCESS via driveDispatchedRun instead of being dispatched
// to a worker Machine. They hold no checkout and no fs/shell tools, so the server
// env is never exposed to the agent. Worker-needing runs (worktree/…) keep
// dispatching to workers unchanged. See lib/run-dispatch.runsInServer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import * as runsModule from "../lib/runs";
import { create, countInFlightWorkers, countInServerRuns } from "../lib/runs";
import { __setRunsApi, dispatchRun, runsInServer } from "../lib/run-dispatch";

// The runs api run-dispatch drives through is injected at runs.ts import time and
// its function references are captured then. To stub driveDispatchedRun /
// countInServerRuns for a test we must RE-INJECT a fresh api; restore the real one
// after. This mirrors runs.ts's own __setRunsApi({...}) call.
const realApi = {
  get: runsModule.get,
  isLeaseLive: runsModule.isLeaseLive,
  failRun: runsModule.setError,
  failPendingRun: runsModule.failPendingRun,
  countInFlightWorkers: runsModule.countInFlightWorkers,
  driveDispatchedRun: runsModule.driveDispatchedRun,
  countInServerRuns: runsModule.countInServerRuns,
  listPendingRunIds: runsModule.listPendingRunIds,
  reconcileOrphanedRuns: runsModule.reconcileOrphanedRuns,
  listLeasedRuns: runsModule.listLeasedRuns,
  handleWorkerDeath: runsModule.handleWorkerDeath,
  checkTreeLimits: runsModule.checkTreeLimits,
} as const;

afterEach(() => {
  __setRunsApi({ ...realApi });
  delete process.env.TASK_ORCH_DISABLE_IN_SERVER_RUNS;
  delete process.env.TASK_ORCH_IN_SERVER_MAX;
  vi.restoreAllMocks();
});

describe("runsInServer", () => {
  it("is true for cwd=none and false for worktree", () => {
    expect(runsInServer({ cwdStrategy: "none" })).toBe(true);
    expect(runsInServer({ cwdStrategy: "worktree" })).toBe(false);
  });

  it("routes back to workers when the kill switch is set", () => {
    process.env.TASK_ORCH_DISABLE_IN_SERVER_RUNS = "1";
    expect(runsInServer({ cwdStrategy: "none" })).toBe(false);
  });
});

describe("dispatchRun — in-server (cwd=none) path", () => {
  it("drives the run in-process and does NOT spawn a worker", async () => {
    const drive = vi.fn().mockResolvedValue(undefined);
    __setRunsApi({ ...realApi, driveDispatchedRun: drive });

    // An <execute> run defaults to cwd=none; defer:true skips the planId kickoff
    // requirement and lands it at 'idle' (claimable).
    const run = await create({ goal: "<execute>", defer: true });
    const spawn = vi.fn(() => 5555);
    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("spawned");
    expect(spawn).not.toHaveBeenCalled();
    expect(drive).toHaveBeenCalledTimes(1);
    expect(drive).toHaveBeenCalledWith(run.id);

    const row = (await runsModule.get(run.id))!;
    expect(row.cwdStrategy).toBe("none");
    expect(row.status).toBe("preparing");
    expect(row.workerScope).toMatch(/^run-\d+-/); // fresh claim held
    expect(row.workerPid).toBe(process.pid); // driven by THIS process
  });

  it("defers to 'pending' when the in-server cap is reached", async () => {
    const drive = vi.fn().mockResolvedValue(undefined);
    const overCap = vi.fn().mockResolvedValue(999);
    __setRunsApi({ ...realApi, driveDispatchedRun: drive, countInServerRuns: overCap });

    const run = await create({ goal: "<execute>", defer: true });
    const result = await dispatchRun(run.id, { spawn: vi.fn(() => 1) });

    expect(result).toBe("deferred");
    expect(drive).not.toHaveBeenCalled();
    const row = (await runsModule.get(run.id))!;
    expect(row.status).toBe("pending");
    expect(row.workerScope).toBeNull();
  });
});

describe("dispatchRun — worker (cwd=worktree) path unchanged", () => {
  it("dispatches to a worker via spawn", async () => {
    const drive = vi.fn().mockResolvedValue(undefined);
    __setRunsApi({ ...realApi, driveDispatchedRun: drive });

    const run = await create({ goal: "<implement>", defer: true });
    const spawn = vi.fn(() => 4242);
    const result = await dispatchRun(run.id, { spawn });

    expect(result).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(drive).not.toHaveBeenCalled();
    const row = (await runsModule.get(run.id))!;
    expect(row.cwdStrategy).toBe("worktree");
    expect(row.workerPid).toBe(4242);
  });
});

describe("worker/in-server accounting are disjoint", () => {
  it("countInFlightWorkers ignores cwd=none; countInServerRuns ignores workers", async () => {
    const none = await create({ goal: "<execute>", defer: true });
    const worktree = await create({ goal: "<implement>", defer: true });

    const workersBefore = await countInFlightWorkers();
    const inServerBefore = await countInServerRuns();

    // Give both a live claim (worker_scope + fresh heartbeat), as the atomic claim
    // would. Deltas keep the assertion robust against rows other tests left behind.
    for (const id of [none.id, worktree.id]) {
      await db
        .update(agentSessions)
        .set({ workerScope: `run-${id}-test`, heartbeatAt: new Date() })
        .where(eq(agentSessions.id, id));
    }

    expect((await countInFlightWorkers()) - workersBefore).toBe(1); // worktree only
    expect((await countInServerRuns()) - inServerBefore).toBe(1); // cwd=none only
  });
});
