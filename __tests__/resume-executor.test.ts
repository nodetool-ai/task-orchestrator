import { randomUUID } from "node:crypto";
// Executor recovery retains one run, workspace and conversation across attempts.

import { NextRequest } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import {
  acceptanceCriteria,
  agentEvents,
  agentMessages,
  agentSessions,
  plans,
  repositories,
  taskDependencies,
  taskNotes,
  tasks,
  inboxEvents,
  runEventSubscriptions,
  runSourceEvents,
  runnerInstances,
  runInputs,
  runTurns,
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

const h = vi.hoisted(() => ({ prompts: [] as string[] }));

// Same fake backend as executor-sidebar-history.test.ts: both executor paths
// drive through runOneTurn → getBackend().runTurn, so one stub covers the
// kickoff turn and every resumed turn.
vi.mock("../lib/agent-backend", () => ({
  resolveBackendId: (backend: string | null | undefined) =>
    (backend ?? process.env.TASK_ORCH_AGENT_BACKEND ?? "pi").trim().toLowerCase(),
  getBackend: async () => ({
    id: "pi",
    listProviders: () => [],
    runTurn: async (args: {
      prompt: string;
      onEvent: (env: Record<string, unknown>) => void | Promise<void>;
    }) => {
      h.prompts.push(args.prompt);
      await args.onEvent({ type: "system", subtype: "init", session_id: "sess-1" });
      await args.onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "scanning tasks" }] },
      });
      await args.onEvent({
        type: "result",
        is_error: false,
        result: "turn done",
        usage: { input_tokens: 5, output_tokens: 5 },
      });
      return {
        envelopes: [],
        summary: "turn done",
        resumeToken: "pi:tok",
        totalCostUsd: 0.01,
        inputTokens: 5,
        outputTokens: 5,
        turns: 1,
      };
    },
  }),
}));

vi.mock("../auth", () => ({
  auth: async () => ({ user: { email: "test@example.com" } }),
}));

import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import * as dispatch from "../lib/run-dispatch";

afterEach(() => vi.restoreAllMocks());
import { POST as resumeRoute } from "../app/api/sessions/[id]/resume/route";

beforeEach(async () => {
  h.prompts.length = 0;
  await seedPersonas();
  await db.delete(agentMessages);
  await db.delete(agentEvents);
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(agentSessions);
  await db.delete(acceptanceCriteria);
  await db.delete(taskNotes);
  await db.delete(taskDependencies);
  await db.delete(tasks);
  await db.delete(plans);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

async function waitFor(
  runId: number,
  statuses: string[],
  timeoutMs = 2000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await runs.get(runId);
    // Also require the in-process runner registration to be gone: runExecute
    // lands the terminal status BEFORE its finally deletes the runner entry, and
    // a resume attempted inside that window trips append's "already in flight"
    // guard (seen on CI, where the window is wider than locally).
    if (r && statuses.includes(r.status) && !runs.isLive(runId)) return r.status;
    await new Promise((res) => setTimeout(res, 20));
  }
  const latest = await runs.get(runId);
  throw new Error(`run ${runId} did not reach ${statuses.join("/")} in ${timeoutMs}ms (status=${latest?.status}, live=${runs.isLive(runId)}, error=${latest?.error})`);
}

async function settledExecutor(): Promise<runs.RunRow> {
  const plan = await repo.createPlan({ title: "Resume Me", date: "2026-07-19" });
  const run = await runs.create({ goal: "<execute>", planId: plan.id });
  await waitFor(run.id, ["completed", "failed"]);
  return (await runs.get(run.id))!;
}

async function collect(
  gen: AsyncGenerator<runs.AppendStreamEvent>
): Promise<runs.AppendStreamEvent[]> {
  const out: runs.AppendStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("in-place resume of a terminal plan executor", () => {
  it("re-drives a completed executor on a follow-up message instead of rejecting it", async () => {
    const prior = await settledExecutor();
    expect(prior.status).toBe("completed");

    const frames = await collect(
      runs.sendMessageToRun({
        runId: prior.id,
        role: "user",
        text: "Task T-1 unblocked — continue the plan.",
        abort: new AbortController(),
      })
    );

    const errors = frames.filter((f) => f.type === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);

    const after = (await runs.get(prior.id))!;
    // The executor ran a real turn: a resumed terminal run starts a fresh
    // attempt, and append's turn-end for a non-worktree run lands 'idle'
    // (resumable again) unless a tool wrote a result/park.
    expect(after.attempt).toBe(prior.attempt + 1);
    const turnFacts = await db.select().from(runSourceEvents).where(and(
      eq(runSourceEvents.sourceRunId, prior.id), eq(runSourceEvents.eventType, "run.turn_finished")
    ));
    expect(turnFacts.map(fact => fact.attempt)).toContain(after.attempt);
    expect(["idle", "completed", "parked"]).toContain(after.status);
    const texts = (await runs.listMessages(prior.id)).map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes("Task T-1 unblocked"))).toBe(true);
  });

  it("still refuses a cancelled executor", async () => {
    const plan = await repo.createPlan({ title: "Cancelled", date: "2026-07-19" });
    const [row] = await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "cancelled", planId: plan.id })
      .returning();

    const frames = await collect(
      runs.sendMessageToRun({
        runId: row.id,
        role: "user",
        text: "wake up",
        abort: new AbortController(),
      })
    );
    const err = frames.find((f) => f.type === "error");
    expect(err && "error" in err ? err.error : "").toMatch(/terminal status 'cancelled'/);
  });
});

describe("runs.resumeExecutorRun (same run and retained workspace)", () => {
  it("renews the same run repeatedly without creating descendants", async () => {
    const prior = await settledExecutor();
    const countBefore = (await runs.list()).length;
    for (const expectedAttempt of [prior.attempt + 1, prior.attempt + 2]) {
      const resumed = await runs.resumeExecutorRun(prior.id);
      expect(resumed.id).toBe(prior.id);
      expect(resumed.parentRunId).toBe(prior.parentRunId);
      expect(resumed.resumeOf).toBe(prior.resumeOf);
      await waitFor(prior.id, ["completed", "failed"]);
      expect((await runs.get(prior.id))!.attempt).toBe(expectedAttempt);
    }
    expect((await runs.list()).length).toBe(countBefore);
  });

  it("retains a nested executor's supervisor and renews its subscription", async () => {
    const plan = await repo.createPlan({ title: "Nested executor", date: "2026-07-19" });
    const [parent] = await db.insert(agentSessions).values({ goal: "<chat>", status: "running" }).returning();
    const [prior] = await db.insert(agentSessions).values({ goal: "<execute>", planId: plan.id, status: "failed", parentRunId: parent.id }).returning();
    const next = await runs.resumeExecutorRun(prior.id, { defer: true });
    expect(next.id).toBe(prior.id);
    expect(next.parentRunId).toBe(parent.id);
    expect(next.resumeOf).toBeNull();
    const [subscription] = await db.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.sourceRunId, prior.id));
    expect(subscription.subscriberRunId).toBe(parent.id);
    expect(subscription.resolvedAttempt).toBe(next.attempt);
  });

  it("preserves the remote runner, task claim, SDK token and unfinished inputs", async () => {
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    const kick = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    const plan = await repo.createPlan({ title: "Retained executor" });
    const task = await repo.createTask({ planId: plan.id, title: "Unpublished work" });
    const [prior] = await db.insert(agentSessions).values({ goal: "<execute>", planId: plan.id,
      personaId: "executor", status: "failed", sdkSessionId: "codex:retained-thread",
      cwdStrategy: "repo", worktreePath: "/retained/repo", branch: "claude/executor", attempt: 3 }).returning();
    await db.update(tasks).set({ executorRunId: prior.id, state: "in_progress", branch: "claude/task-work" }).where(eq(tasks.id, task.id));
    await db.insert(runnerInstances).values({ runId: prior.id, provider: "sprites", state: "ready", spriteName: "retained-executor", workerGeneration: 7 });
    const [turn] = await db.insert(runTurns).values({ id: randomUUID(), runId: prior.id, ordinal: 1, attempt: 3, state: "active" }).returning();
    const [message] = await db.insert(agentMessages).values({ runId: prior.id, role: "user", content: "[]" }).returning();
    const [input] = await db.insert(runInputs).values({ id: randomUUID(), runId: prior.id, inputSeq: 1,
      messageId: message.id, kind: "user", status: "assigned", assignedTurnId: turn.id }).returning();
    const resumed = await runs.resumeExecutorRun(prior.id);
    expect(kick).toHaveBeenCalledWith(prior.id);
    expect(resumed).toMatchObject({ id: prior.id, attempt: 4, sdkSessionId: prior.sdkSessionId,
      worktreePath: prior.worktreePath, branch: prior.branch });
    const [retained] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, prior.id));
    expect(retained).toMatchObject({ spriteName: "retained-executor", workerGeneration: 7 });
    expect((await repo.getTask(task.id))!.executorRunId).toBe(prior.id);
    const [requeued] = await db.select().from(runInputs).where(eq(runInputs.id, input.id));
    expect(requeued).toMatchObject({ status: "pending", assignedTurnId: null });
    const [oldTurn] = await db.select().from(runTurns).where(eq(runTurns.id, turn.id));
    expect(oldTurn.state).toBe("superseded");
    expect(await runs.list({ goal: "<execute>" })).toHaveLength(1);
  });

  it("consumes unfinished user steering when resuming locally", async () => {
    const plan = await repo.createPlan({ title: "Local input recovery" });
    const [prior] = await db.insert(agentSessions).values({ goal: "<execute>", planId: plan.id,
      personaId: "executor", status: "failed", cwdStrategy: "repo" }).returning();
    const [turn] = await db.insert(runTurns).values({ id: randomUUID(), runId: prior.id, ordinal: 1,
      attempt: 1, state: "active" }).returning();
    const [message] = await db.insert(agentMessages).values({ runId: prior.id, role: "user",
      content: JSON.stringify([{ type: "text", text: "Retained instruction: preserve the legacy API" }]) }).returning();
    const [input] = await db.insert(runInputs).values({ id: randomUUID(), runId: prior.id, inputSeq: 1,
      messageId: message.id, kind: "user", status: "assigned", assignedTurnId: turn.id }).returning();
    await runs.resumeExecutorRun(prior.id);
    await waitFor(prior.id, ["completed", "failed"]);
    expect(h.prompts[0]).toContain("Retained instruction: preserve the legacy API");
    const [consumed] = await db.select().from(runInputs).where(eq(runInputs.id, input.id));
    expect(consumed.status).toBe("completed");
    const [oldTurn] = await db.select().from(runTurns).where(eq(runTurns.id, turn.id));
    expect(oldTurn.state).toBe("superseded");
  });

  it("refuses remote recovery without a retained runner", async () => {
    const prior = await settledExecutor();
    vi.spyOn(dispatch, "remoteRunnerEnabled").mockReturnValue(true);
    const kick = vi.spyOn(dispatch, "dispatchRun").mockResolvedValue("spawned");
    await expect(runs.resumeExecutorRun(prior.id)).rejects.toThrow(/no retained runner/);
    expect(kick).not.toHaveBeenCalled();
    expect((await runs.get(prior.id))!.attempt).toBe(prior.attempt);
  });

  it("allows only one concurrent renewal", async () => {
    const prior = await settledExecutor();
    const results = await Promise.allSettled([
      runs.resumeExecutorRun(prior.id, { defer: true }),
      runs.resumeExecutorRun(prior.id, { defer: true }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await runs.get(prior.id))!.attempt).toBe(prior.attempt + 1);
  });

  it.each(["running", "cancelled", "closed"])("refuses a %s executor", async (status) => {
    const plan = await repo.createPlan({ title: "Not resumable" });
    const [prior] = await db.insert(agentSessions).values({ goal: "<execute>", planId: plan.id, status }).returning();
    await expect(runs.resumeExecutorRun(prior.id, { defer: true })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses non-executor runs", async () => {
    const [chat] = await db.insert(agentSessions).values({ goal: "<chat>", status: "failed" }).returning();
    await expect(runs.resumeExecutorRun(chat.id)).rejects.toThrow(/not a plan-executor run/);
  });
});

describe("POST /api/sessions/[id]/resume on an executor", () => {
  it("returns the same executor identity", async () => {
    const plan = await repo.createPlan({ title: "Route", date: "2026-07-19" });
    const [prior] = await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "budget_exhausted", planId: plan.id })
      .returning();

    const res = await resumeRoute(
      new NextRequest(`http://test/api/sessions/${prior.id}/resume`, { method: "POST" }),
      { params: Promise.resolve({ id: String(prior.id) }) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; goal: string; parentRunId: number };
    expect(body.goal).toBe("<execute>");
    expect(body.id).toBe(prior.id);
    expect(body).toHaveProperty("cwdStrategy", "repo");
    expect(runs.isImplementWorktree({ goal: "<execute>", cwdStrategy: "worktree" })).toBe(false);
    expect(body.parentRunId).toBeNull();
    expect(body).toHaveProperty("resumeOf", null);
    // Let the renewed attempt settle before the test ends.
    await waitFor(body.id, ["completed", "failed"]);
  });
});
