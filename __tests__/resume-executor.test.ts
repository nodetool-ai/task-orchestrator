// Resuming a plan-executor run.
//
// Two mechanisms, both previously broken for executors:
//  1. In-place resume (composer follow-up → sendMessageToRun → append on
//     non-remote deployments): append's terminal-resume gate admitted only
//     worktree runs, so a completed/failed executor (cwd_strategy='repo')
//     erred with "cannot resume" — while the same action worked on remote
//     deployments via the dispatch path. Fixed via isResumableRun.
//  2. Fork-resume (POST /api/sessions/[id]/resume, the mobile ResumeSheet):
//     the route resolved the prior run through agent.getSession, which returns
//     null for any run without a taskId — every executor 404'd. Fixed via
//     runs.resumeExecutorRun (a fresh <execute> generation on the same plan).

import { NextRequest } from "next/server";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
} from "../db/schema";
import { seedPersonas } from "../db/seed-personas";

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
      onEvent: (env: Record<string, unknown>) => void | Promise<void>;
    }) => {
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
import { POST as resumeRoute } from "../app/api/sessions/[id]/resume/route";

beforeEach(async () => {
  await seedPersonas();
  await db.delete(agentMessages);
  await db.delete(agentEvents);
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
  timeoutMs = 5000
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
  throw new Error(`run ${runId} did not reach ${statuses.join("/")} in ${timeoutMs}ms`);
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

describe("runs.resumeExecutorRun (fork a fresh generation)", () => {
  it("starts a new <execute> run on the same plan, linked to and briefed on the prior", async () => {
    const plan = await repo.createPlan({ title: "Fork Me", date: "2026-07-19" });
    const [prior] = await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "failed", planId: plan.id, error: "worker died" })
      .returning();

    const next = await runs.resumeExecutorRun(prior.id);
    expect(next.goal).toBe("<execute>");
    expect(next.planId).toBe(plan.id);
    expect(next.parentRunId).toBe(prior.id);
    await waitFor(next.id, ["completed", "failed"]);

    // The kickoff prompt carries the resume note (prior run + its error) as
    // operator instructions on top of the execute scaffold.
    const kickoff = JSON.stringify((await runs.listMessages(next.id))[0].content);
    expect(kickoff).toContain(`#${prior.id}`);
    expect(kickoff).toContain("worker died");
    expect(kickoff).toContain("list_tasks");
  });

  it("refuses to fork while the prior generation is not settled", async () => {
    const plan = await repo.createPlan({ title: "Live", date: "2026-07-19" });
    const [prior] = await db
      .insert(agentSessions)
      .values({
        goal: "<execute>",
        status: "running",
        planId: plan.id,
      })
      .returning();
    await expect(runs.resumeExecutorRun(prior.id)).rejects.toThrow(/send it a message/);
  });

  it("refuses non-executor runs", async () => {
    const [chat] = await db
      .insert(agentSessions)
      .values({ goal: "<chat>", status: "failed" })
      .returning();
    await expect(runs.resumeExecutorRun(chat.id)).rejects.toThrow(/not a plan-executor run/);
  });
});

describe("POST /api/sessions/[id]/resume on an executor", () => {
  it("no longer 404s: forks a fresh generation and returns it", async () => {
    const plan = await repo.createPlan({ title: "Route", date: "2026-07-19" });
    const [prior] = await db
      .insert(agentSessions)
      .values({ goal: "<execute>", status: "budget_exhausted", planId: plan.id })
      .returning();

    const res = await resumeRoute(
      new NextRequest(`http://test/api/sessions/${prior.id}/resume`, { method: "POST" }),
      { params: Promise.resolve({ id: String(prior.id) }) }
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: number; goal: string; parentRunId: number };
    expect(body.goal).toBe("<execute>");
    expect(body.parentRunId).toBe(prior.id);
    // Let the forked generation's kickoff turn settle before the test ends.
    await waitFor(body.id, ["completed", "failed"]);
  });
});
