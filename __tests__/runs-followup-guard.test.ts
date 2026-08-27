// __tests__/runs-followup-guard.test.ts
//
// FIX 4 (M14): followUp() (the GitHub webhook autofix) guarded only with the
// in-process isLive() check, which is blind to a DETACHED worker driving the same
// run in another process. It would then start a SECOND concurrent turn against the
// same branch/worktree. followUp() now also bails on a FRESH read when the DB
// shows a live worker (resolveLiveness alive) —
// both before taking the per-run lock slot and after acquiring it.

import { installFakeRunnerProvider, setFakeRunLiveness } from "./helpers/fake-runner-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentSessions } from "../db/schema";
import { create, get, followUp, isLive } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";

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
      .set({ status: "running"})
      .where(eq(agentSessions.id, runId));
    installFakeRunnerProvider();
    await setFakeRunLiveness(runId, { status: "alive", incarnation: "w1" }, "w1");

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
      .set({ status: "idle", workerScope: "scope-live"})
      .where(eq(agentSessions.id, runId));
    installFakeRunnerProvider();
    await setFakeRunLiveness(runId, { status: "alive", incarnation: "w1" }, "w1");

    await followUp(runId, "please fix CI");

    expect(getBackend).not.toHaveBeenCalled();
    expect(isLive(runId)).toBe(false);
    expect((await get(runId))?.status).toBe("idle");
  });
});

// followUp must DISPATCH, not execute, when a remote runner exists: the control
// plane has no SESSION_ROOT/REPO_CACHE_DIR and its image ships without git, so
// prepareCwd's host/dev branch fails instantly there ("not a git repository" /
// spawn git ENOENT — runs 133/137/140/144, with the CI-autofix poller re-failing
// already-completed runs every 2 minutes). The prompt must land as a USER row
// (dispatchTurnPrompt replays only the unanswered user backlog; a system row is
// silently dropped) and the ci-autofix addProfiles merge must be persisted to
// the run row (the dispatched worker mounts tools from the row, not from
// per-call options).
describe("followUp() dispatches instead of executing on a remote-runner deployment", () => {
  it("persists the prompt as a user message, merges profiles onto the row, and calls dispatchRun", async () => {
    const getBackend = vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    const dispatchSpy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const runId = await makeWorktreeRun();
    await db
      .update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.id, runId));

    await followUp(runId, "please fix CI", { addProfiles: ["gh_pr", "gh_ci"] });

    // Dispatched, never executed in this process.
    expect(dispatchSpy).toHaveBeenCalledWith(runId);
    expect(getBackend).not.toHaveBeenCalled();

    // The prompt is a USER row so the dispatched turn's backlog replay picks it up.
    const msgs = await db.select().from(agentMessages).where(eq(agentMessages.runId, runId));
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toContain("please fix CI");

    // The gh tool profiles are persisted on the row for the worker to mount.
    const row = await get(runId);
    const profiles = (row?.toolsProfile ?? "").split(",");
    expect(profiles).toContain("gh_pr");
    expect(profiles).toContain("gh_ci");
  });

  it("still bails on a live worker before persisting or dispatching", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    const dispatchSpy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const runId = await makeWorktreeRun();
    await db
      .update(agentSessions)
      .set({ status: "idle", workerScope: "scope-live"})
      .where(eq(agentSessions.id, runId));
    installFakeRunnerProvider();
    await setFakeRunLiveness(runId, { status: "alive", incarnation: "w1" }, "w1");

    await followUp(runId, "please fix CI");

    expect(dispatchSpy).not.toHaveBeenCalled();
    const msgs = await db.select().from(agentMessages).where(eq(agentMessages.runId, runId));
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("keeps the in-process turn as the host/dev fallback (no remote runner)", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(false);
    const dispatchSpy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const getBackend = vi.spyOn(backend, "getBackend").mockResolvedValue(fakeBackend());
    const runId = await makeWorktreeRun();
    await db
      .update(agentSessions)
      .set({ status: "completed" })
      .where(eq(agentSessions.id, runId));

    // The fake worktree path doesn't exist, so the in-process turn fails in
    // prepareCwd — what matters here is the ROUTING: no dispatch, and the
    // in-process path ran (landing the run failed with a cwd error).
    await followUp(runId, "please fix CI", { push: false });

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect((await get(runId))?.status).toBe("failed");
  });
});
