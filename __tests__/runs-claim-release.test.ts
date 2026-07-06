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
import { agentSessions, agentMessages } from "../db/schema";
import { create, get, close, driveDispatchedRun, append, listMessages } from "../lib/runs";
import { seedPersonas } from "../db/seed-personas";
import * as repo from "../lib/repo";
import * as backend from "../lib/agent-backend";
import * as dispatch from "../lib/run-dispatch";
import { collectExtensions, runInterceptors } from "../lib/agent-backend/collect";

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

// A backend that records the prompt it was driven with and the cost it reports.
function capturingBackend(capture: { prompt?: string; extensions?: any[] }, totalCostUsd: number | null = null) {
  return {
    id: "fake",
    async runTurn(args: any) {
      capture.prompt = args.prompt;
      capture.extensions = args.extensions;
      args.onEvent({ type: "result", is_error: false, result: "ok", usage: {} });
      return { summary: "ok", resumeToken: "s", turns: 1, inputTokens: 0, outputTokens: 0, totalCostUsd };
    },
  } as any;
}

async function insertUser(runId: number, text: string) {
  await db.insert(agentMessages).values({
    runId,
    role: "user",
    content: JSON.stringify([{ type: "text", text }]),
    createdAt: new Date(),
  });
}

async function claim(runId: number) {
  await db.update(agentSessions)
    .set({ status: "preparing", workerScope: "run-x", workerPid: 1, heartbeatAt: new Date() })
    .where(eq(agentSessions.id, runId));
}

describe("dispatchTurnPrompt backlog + initial-prompt preference (FIX 3b / FIX 7a)", () => {
  it("replays the unanswered backlog (all user messages since the last agent reply)", async () => {
    const cap: { prompt?: string } = {};
    vi.spyOn(backend, "getBackend").mockResolvedValue(capturingBackend(cap));
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "adhoc", cwdStrategy: "none", defer: true });
    // Two follow-ups piled up while the worker was busy — the old code replayed
    // only the LAST; the fix replays both, blank-line joined.
    await insertUser(run.id, "first thing");
    await insertUser(run.id, "second thing");
    await claim(run.id);

    await driveDispatchedRun(run.id);

    expect(cap.prompt).toContain("first thing");
    expect(cap.prompt).toContain("second thing");
    expect(cap.prompt).toBe("first thing\n\nsecond thing");
  });

  it("prefers a persisted initial prompt over the synthesized task prompt", async () => {
    const cap: { prompt?: string } = {};
    vi.spyOn(backend, "getBackend").mockResolvedValue(capturingBackend(cap));
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const plan = await repo.createPlan({ title: "P", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Synthesized Title", date: "2026-07-04" });
    // taskId set + no sdkSessionId → the OLD dispatchTurnPrompt would return
    // buildImplementPrompt(task). A persisted initial prompt must now win.
    const run = await create({ goal: "adhoc", cwdStrategy: "none", taskId: task.id, defer: true });
    await insertUser(run.id, "custom kickoff prompt");
    await claim(run.id);

    await driveDispatchedRun(run.id);

    expect(cap.prompt).toBe("custom kickoff prompt");
    expect(cap.prompt).not.toContain("Synthesized Title");
  });
});

describe("env-scrub extension is registered for every run (Tier 0)", () => {
  it("strips DATABASE_URL et al from a bash command for an ordinary run, regardless of persona/backend", async () => {
    const cap: { prompt?: string; extensions?: any[] } = {};
    vi.spyOn(backend, "getBackend").mockResolvedValue(capturingBackend(cap));
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({ goal: "adhoc", cwdStrategy: "none", defer: true });
    await insertUser(run.id, "go");
    await claim(run.id);

    await driveDispatchedRun(run.id);

    expect(cap.extensions).toBeTruthy();
    const collected = await collectExtensions(cap.extensions!);
    const decision = await runInterceptors(collected.interceptors, "bash", { command: "printenv DATABASE_URL" });
    expect(decision).not.toBeNull();
    expect((decision as any).input.command).toContain("unset ");
    expect((decision as any).input.command).toContain("DATABASE_URL");
    expect((decision as any).input.command).toContain("printenv DATABASE_URL");
  });
});

describe("checkBudget enforces maxUsd (FIX 5)", () => {
  it("lands budget_exhausted once the reported cost meets the cap", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(capturingBackend({}, 5));
    const run = await create({ goal: "adhoc", cwdStrategy: "none", budget: { maxUsd: 1 }, defer: true });

    for await (const _ev of append({ runId: run.id, role: "user", text: "go" })) void _ev;

    const after = await get(run.id);
    expect(after?.status).toBe("budget_exhausted");
    expect(after?.totalCostUsd).toBe(5);
  });

  it("does NOT trip when cost is unknown (pi-style null cost)", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue(capturingBackend({}, null));
    const run = await create({ goal: "adhoc", cwdStrategy: "none", budget: { maxUsd: 1 }, defer: true });

    for await (const _ev of append({ runId: run.id, role: "user", text: "go" })) void _ev;

    // Cost is null → cap can't trip; a non-worktree run lands idle.
    expect((await get(run.id))?.status).toBe("idle");
  });
});

describe("create() persists a custom initialPrompt in detached mode (FIX 7)", () => {
  beforeEach(() => {
    process.env.TASK_ORCH_DETACHED_RUNS = "1";
  });

  it("persists it as the first user message for a worktree kickoff", async () => {
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const plan = await repo.createPlan({ title: "P2", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "T2", date: "2026-07-04" });
    const run = await create({ goal: "<implement>", taskId: task.id, initialPrompt: "do the thing" });
    await new Promise((r) => setTimeout(r, 30)); // let the async launch branch run

    const msgs = await listMessages(run.id);
    expect(msgs.some((m) => m.role === "user" && JSON.stringify(m.content).includes("do the thing"))).toBe(true);
  });

  it("persists it as the first user message for a review run", async () => {
    vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const run = await create({
      goal: "<review>",
      cwdStrategy: "worktree_at_pr",
      prUrl: "https://github.com/x/y/pull/9",
      initialPrompt: "review with these constraints",
    });
    await new Promise((r) => setTimeout(r, 30));

    const msgs = await listMessages(run.id);
    expect(
      msgs.some((m) => m.role === "user" && JSON.stringify(m.content).includes("review with these constraints"))
    ).toBe(true);
  });
});
