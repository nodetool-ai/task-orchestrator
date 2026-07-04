// __tests__/runs-claim-release.test.ts
//
// Two detached-worker claim-lifecycle regressions in lib/runs.ts:
//
// BUG 1: a single-turn detached worker (implement/review/execute) lands its run
//   at a terminal status but never cleared the worker claim (worker_scope/
//   worker_pid). handleWorkerDeath early-returns on terminal statuses before its
//   release, so the ghost claim wedged the run forever: dispatchRun returned
//   'already-claimed' (follow-ups persisted but spawned nothing) and the claim
//   counted against the admission budget until the heartbeat went stale.
//   Fix: driveDispatchedRun releases the claim in a finally once the single turn
//   returns (the chat path returns earlier and manages its own claim).
//
// BUG 3: close() only aborted the in-process runner, so a detached worker kept
//   burning its turn to completion. Fix: close() also sets cancel_requested=1 and
//   hard-stops the runner, mirroring cancel().

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, close, driveDispatchedRun } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";

// Minimal backend stub: emit one assistant message + a result and return.
function fakeBackend() {
  return {
    id: "fake",
    async runTurn(args: any) {
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
      args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
      return { summary: "ok", resumeToken: "sess-1", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
    },
  } as any;
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TASK_ORCH_DETACHED_RUNS;
});

describe("driveDispatchedRun releases the worker claim (BUG 1)", () => {
  it("clears worker_scope/worker_pid after a single-turn drive completes", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    // A non-worktree, non-chat run: routes through driveDispatchedRun's else
    // branch (kickoffFirstTurn → append → one turn → idle) with no git/worktree.
    const run = await create({ goal: "adhoc task", cwdStrategy: "none", defer: true });
    // Simulate dispatchRun's claim: this process owns the run's worker slot.
    await db.update(agentSessions)
      .set({ workerScope: "run-x-1", workerPid: 4242, heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    await driveDispatchedRun(run.id);

    const after = await get(run.id);
    expect(after?.workerScope).toBeNull();
    expect(after?.workerPid).toBeNull();
    // The turn landed resumable-idle, not wedged in 'preparing'.
    expect(after?.status).toBe("idle");
  });

  it("releases the claim even when the drive errors out early", async () => {
    // A dispatched <review> run with no prUrl setErrors immediately inside the
    // try — the finally must still release the claim.
    const run = await create({
      goal: "<review>",
      cwdStrategy: "worktree_at_pr",
      prUrl: "https://example.com/pr/1",
      defer: true,
    });
    await db.update(agentSessions)
      .set({ prUrl: null, workerScope: "run-x-2", workerPid: 99, heartbeatAt: new Date() })
      .where(eq(agentSessions.id, run.id));

    await driveDispatchedRun(run.id);

    const after = await get(run.id);
    expect(after?.status).toBe("failed");
    expect(after?.workerScope).toBeNull();
    expect(after?.workerPid).toBeNull();
  });
});

describe("close() cross-process stop (BUG 3)", () => {
  it("sets cancel_requested and hard-stops the detached worker", async () => {
    const stop = vi.spyOn(dispatch, "stopRunner").mockResolvedValue(undefined as any);
    const run = await create({ goal: "<implement>", defer: true });
    await db.update(agentSessions)
      .set({ status: "running", heartbeatAt: new Date(), workerScope: "scope-1", workerPid: 7 })
      .where(eq(agentSessions.id, run.id));

    const after = await close(run.id);

    expect(after.status).toBe("closed");
    expect(after.cancelRequested).toBe(1);
    expect(stop).toHaveBeenCalledWith("scope-1");
  });
});
