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
import { agentMessages, agentSessions, runInputs, tasks } from "../db/schema";
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
  await db.delete(tasks);
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

async function makeTaskWorktreeRun(status: string, startedAt = new Date()): Promise<number> {
  await db.insert(tasks).values({ id: "T-followup", title: "Follow-up ownership", repoId: "R-default" })
    .onConflictDoNothing();
  const [row] = await db.insert(agentSessions).values({ taskId: "T-followup", status,
    goal: "<implement>", cwdStrategy: "worktree", branch: "claude/t-followup",
    worktreePath: "/tmp/followup-task", deliveryVersion: 2, attempt: 1, startedAt })
    .returning({ id: agentSessions.id });
  return row.id;
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
  it("atomically queues one v2 input on the incremented attempt", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const runId = await makeTaskWorktreeRun("completed");

    expect(await followUp(runId, "repair this head")).toBe(true);

    const row = await get(runId);
    expect(row?.attempt).toBe(2);
    expect(row?.status).toBe("pending");
    expect(await db.select().from(agentMessages).where(eq(agentMessages.runId, runId))).toHaveLength(1);
    const inputs = await db.select().from(runInputs).where(eq(runInputs.runId, runId));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].status).toBe("pending");
  });

  it("rejects an older terminal run when a newer unowned run is pending without creating input", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    const dispatchSpy = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const old = await makeTaskWorktreeRun("completed", new Date(Date.now() - 1_000));
    await makeTaskWorktreeRun("pending", new Date());

    expect(await followUp(old, "must not run")).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(agentMessages).where(eq(agentMessages.runId, old))).toHaveLength(0);
    expect(await db.select().from(runInputs).where(eq(runInputs.runId, old))).toHaveLength(0);
  });

  it("serializes concurrent run creation and terminal follow-up to one task writer", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const old = await makeTaskWorktreeRun("completed", new Date(Date.now() - 1_000));

    const [resumed, created] = await Promise.allSettled([
      followUp(old, "race repair"),
      create({ taskId: "T-followup", repoId: "R-default", goal: "<implement>",
        cwdStrategy: "worktree", defer: true }),
    ]);

    const rows = await db.select().from(agentSessions).where(eq(agentSessions.taskId, "T-followup"));
    const owners = rows.filter((r) => !["completed", "failed", "cancelled", "closed", "budget_exhausted"].includes(r.status));
    expect(owners).toHaveLength(1);
    expect((resumed.status === "fulfilled" && resumed.value === true) || created.status === "fulfilled").toBe(true);
  });

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
    await followUp(runId, "please fix CI");

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect((await get(runId))?.status).toBe("failed");
  });
});
