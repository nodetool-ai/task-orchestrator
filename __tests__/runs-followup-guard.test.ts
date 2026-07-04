// __tests__/runs-followup-guard.test.ts
//
// FIX 4 (M14): followUp() (the GitHub webhook autofix) guarded only with the
// in-process isLive() check, which is blind to a DETACHED worker driving the same
// run in another process. It would then start a SECOND concurrent turn against the
// same branch/worktree. followUp() now also bails on a FRESH read when the DB
// shows a live lease (isLeaseLive) or a live worker owns the run (isWorkerLive) —
// both before taking the per-run lock slot and after acquiring it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import { create, get, followUp, isLive } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as backend from "../lib/agent-backend";

function fakeBackend() {
  return {
    id: "fake",
    async runTurn(args: any) {
      args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
      return { summary: "ok", resumeToken: "s", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd: null };
    },
  } as any;
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentSessions);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// A worktree run with a branch/worktree recorded — the shape followUp requires.
async function makeWorktreeRun(): Promise<number> {
  const run = await create({ goal: "<implement>", defer: true });
  await db
    .update(agentSessions)
    .set({ branch: "claude/x-1", worktreePath: "/tmp/nonexistent-followup-guard" })
    .where(eq(agentSessions.id, run.id));
  return run.id;
}

describe("followUp() bails on a cross-process live run (FIX 4)", () => {
  it("bails when the DB shows a live lease (a turn in flight elsewhere)", async () => {
    const getBackend = vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const runId = await makeWorktreeRun();
    // Detached worker mid-turn in another process: running + fresh heartbeat.
    await db
      .update(agentSessions)
      .set({ status: "running", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, runId));

    await followUp(runId, "please fix CI");

    // Never spun up a turn: no backend call, no in-process runner, status unchanged.
    expect(getBackend).not.toHaveBeenCalled();
    expect(isLive(runId)).toBe(false);
    expect((await get(runId))?.status).toBe("running");
  });

  it("bails when a live worker owns the run (parked chat/idle with a fresh lease)", async () => {
    const getBackend = vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const runId = await makeWorktreeRun();
    // idle is not a lease status, but the worker still holds its claim + heartbeat.
    await db
      .update(agentSessions)
      .set({ status: "idle", workerScope: "scope-live", heartbeatAt: new Date() })
      .where(eq(agentSessions.id, runId));

    await followUp(runId, "please fix CI");

    expect(getBackend).not.toHaveBeenCalled();
    expect(isLive(runId)).toBe(false);
    expect((await get(runId))?.status).toBe("idle");
  });
});
