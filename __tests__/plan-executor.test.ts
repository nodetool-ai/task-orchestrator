import { eq, ne, sql } from "drizzle-orm";
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
} from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { dispatchRun } from "../lib/run-dispatch";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { decideTurnEndStatus } from "../lib/run-state";
import { buildExecutePrompt } from "../lib/run-templates";
import { PERSONAS } from "../lib/personas";
import { SPAWN_TOOLS } from "../lib/extensions/spawn";
import { seedPersonas } from "../db/seed-personas";

beforeEach(async () => {
  // Personas back the agent_runs.persona_id FK; seed before any run insert.
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

function tool(name: string) {
  const t = ORCHESTRATOR_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not in registry`);
  return t;
}

const ctx = { author: "test" as const };

// Insert an agent_runs row directly, bypassing the worker kickoff.
async function insertRun(
  values: Partial<typeof agentSessions.$inferInsert>
): Promise<number> {
  const row = await db
    .insert(agentSessions)
    .values({ goal: "<review>", status: "running", ...values })
    .returning();
  return row[0].id;
}

describe("executor persona", () => {
  it("has repository access and delegates within the existing run", () => {
    const p = PERSONAS.find((x) => x.id === "executor")!;
    expect(p.toolsProfile).toBe("orchestrator,repo_write,gh_pr,gh_ci");
    expect(p.systemPrompt).toContain("CI ownership is single-writer");
    expect(p.systemPrompt).toContain("ci.autofix_exhausted");
    expect(p.systemPrompt).toContain("ONE active sub-agent");
  });

  it.each(["executor", "implementor"])("rejects both child-run tools for an execute run with persona %s", async (personaId) => {
    const plan = await repo.createPlan({ title: "Single worker", date: "2026-09-14" });
    const task = await repo.createTask({ planId: plan.id, title: "Ready", date: "2026-09-14" });
    const parent = await insertRun({ goal: "<execute>", personaId, planId: plan.id });
    const before = await runs.list({});
    const start = tool("start_session");
    const spawn = SPAWN_TOOLS.find((t) => t.name === "spawn__spawn_agent")!;
    for (const result of [
      await start.execute({ task_id: task.id }, { author: "executor", runId: parent }),
      await spawn.execute({ goal: "<implement>", persona: "implementor", tools_profile: "orchestrator,repo_write", cwd_strategy: "worktree", task_id: task.id }, { author: "executor", runId: parent }),
    ]) {
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("same run");
    }
    await expect(runs.create({ goal: "<implement>", taskId: task.id, parentRunId: parent, defer: true })).rejects.toThrow(/cannot create or start child runs/);
    expect((await runs.list({})).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect((await repo.getTask(task.id))?.state).toBe("todo");
  });

  it("cannot bypass autofix by appending to or replacing a failing implementor", async () => {
    const plan = await repo.createPlan({ title: "CI ownership", date: "2026-09-11" });
    const task = await repo.createTask({ planId: plan.id, title: "Fix me", date: "2026-09-11" });
    await repo.transitionTask(task.id, { state: "in_progress", assignee: "child" });
    await repo.transitionTask(task.id, { state: "testing" });
    await repo.transitionTask(task.id, { state: "failing" });

    const parent = await insertRun({
      goal: "<execute>",
      status: "running",
      personaId: "executor",
      planId: plan.id,
    });
    const child = await insertRun({
      goal: "<implement>",
      status: "completed",
      personaId: "implementor",
      parentRunId: parent,
      taskId: task.id,
      cwdStrategy: "worktree",
      branch: "claude/ci-owner",
      worktreePath: "/tmp/ci-owner",
    });

    const append = SPAWN_TOOLS.find((entry) => entry.name === "spawn__append_message")!;
    const appendResult = await append.execute(
      { run_id: child, text: "Fix CI now" },
      { author: "executor", runId: parent }
    );
    expect(appendResult.isError).toBe(true);
    expect((appendResult.content[0] as { text: string }).text).toMatch(/CI repair dispatch is owned/i);

    const spawn = SPAWN_TOOLS.find((entry) => entry.name === "spawn__spawn_agent")!;
    const spawnResult = await spawn.execute(
      {
        goal: "<implement>",
        persona: "implementor",
        tools_profile: "orchestrator,repo_write,gh_pr,gh_ci",
        cwd_strategy: "worktree",
        task_id: task.id,
      },
      { author: "executor", runId: parent }
    );
    expect(spawnResult.isError).toBe(true);
    expect((spawnResult.content[0] as { text: string }).text).toMatch(/CI repair dispatch is owned/i);

    const start = ORCHESTRATOR_TOOLS.find((entry) => entry.name === "start_session")!;
    const startResult = await start.execute(
      { task_id: task.id, resume_of: child },
      { author: "executor", runId: parent }
    );
    expect(startResult.isError).toBe(true);
    expect((startResult.content[0] as { text: string }).text).toMatch(/CI repair dispatch is owned/i);
  });
});

describe("buildExecutePrompt", () => {
  it("lists tasks with state and dependencies", async () => {
    const plan = await repo.createPlan({ title: "Ship It", date: "2026-06-18" });
    const a = await repo.createTask({ planId: plan.id, title: "First", date: "2026-06-18" });
    const b = await repo.createTask({
      planId: plan.id,
      title: "Second",
      date: "2026-06-18",
      dependencies: [a.id],
    });
    const prompt = buildExecutePrompt(
      (await repo.getPlan(plan.id))!,
      await repo.listTasks({ planId: plan.id })
    );
    expect(prompt).toContain(plan.id);
    expect(prompt).toContain(a.id);
    expect(prompt).toContain(b.id);
    expect(prompt).toContain(`deps:[${a.id}]`);
    // 2 open of 2.
    expect(prompt).toContain("2 open of 2");
  });
});

describe("create({ goal: '<execute>' })", () => {
  it("requires a planId", async () => {
    await expect(runs.create({ goal: "<execute>" })).rejects.toThrow(/planId/);
  });

  it("defers with repo cwd and an executor profile that supports local implementation", async () => {
    const plan = await repo.createPlan({ title: "Deferred", date: "2026-06-18" });
    const run = await runs.create({ goal: "<execute>", planId: plan.id, defer: true });
    expect(run.goal).toBe("<execute>");
    expect(run.cwdStrategy).toBe("repo");
    expect(run.toolsProfile).toBe("orchestrator,repo_write,gh_pr,gh_ci");
    expect(run.personaId).toBe("executor");
    expect(run.planId).toBe(plan.id);
    expect(run.status).toBe("idle");
  });
});

describe("await_session", () => {
  it("errors when the session does not exist", async () => {
    const res = await tool("await_session").execute({ session_id: 999999 }, ctx);
    expect(res.isError).toBe(true);
  });

  it("returns immediately for an already-terminal run and parses the verdict", async () => {
    const id = await insertRun({
      status: "completed",
      outcome: JSON.stringify({ verdict: "approve", summary: "LGTM" }),
      prUrl: "https://github.com/x/y/pull/1",
    });
    const res = await tool("await_session").execute({ session_id: id }, ctx);
    expect(res.isError).toBeFalsy();
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.status).toBe("completed");
    expect(out.verdict).toBe("approve");
    expect(out.pr_url).toBe("https://github.com/x/y/pull/1");
  });

  it("parks the caller instead of blocking for a running session", async () => {
    const parent = await insertRun({ goal: "<chat>", status: "running" });
    await db.update(agentSessions).set({ deliveryVersion: 1 }).where(eq(agentSessions.id, parent));
    const id = await insertRun({ status: "running", parentRunId: parent });
    const res = await tool("await_session").execute(
      { session_id: id, timeout_seconds: 60 },
      { ...ctx, runId: parent }
    );
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.status).toBe("running");
    expect(out.waiting).toBe(true);
    expect(out.caller_run_id).toBe(parent);
    expect(out.timeout_timer_id).toEqual(expect.any(Number));
    const parentRow = await runs.get(parent);
    expect(parentRow?.parkReason).toBe("waiting");
  });

  it("await on a live child parks the turn end at 'parked' (event path, no held connection)", async () => {
    // R7b: await_session never blocks — it writes the park effect and returns
    // immediately. The turn-end decision then lands 'parked' from that
    // parkReason, so the run waits on the child's terminal EVENT rather than a
    // held HTTP connection. This ties the tool's park write to decideTurnEndStatus.
    const parent = await insertRun({ goal: "<chat>", status: "running" });
    await db.update(agentSessions).set({ deliveryVersion: 1 }).where(eq(agentSessions.id, parent));
    const child = await insertRun({ status: "running", parentRunId: parent });

    const res = await tool("await_session").execute(
      { session_id: child, timeout_seconds: 60 },
      { ...ctx, runId: parent }
    );
    // Returned immediately with a park directive, not a blocking wait.
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.waiting).toBe(true);

    const parentRow = await runs.get(parent);
    expect(parentRow?.parkReason).toBe("waiting");

    // Re-reading state at turn end (chat default 'idle') with the park reason
    // set lands the run 'parked'.
    const landed = decideTurnEndStatus({
      goal: "<chat>",
      freshStatus: "running",
      parkReason: parentRow?.parkReason ?? null,
      result: null,
      budgetHit: false,
      defaultStatus: "idle",
    });
    expect(landed).toBe("parked");
  });
});

// The active-review guard behavior formerly exercised through start_review
// (now removed with the agent reviewer) is still worth covering at the
// runs.list level, since <review> goal runs and their activeOnly filtering
// remain live plumbing (see lib/runs.ts runReview).
describe("runs.list activeOnly filter for <review> runs", () => {
  it("only counts non-terminal runs", async () => {
    const plan = await repo.createPlan({ title: "Review Guard Done", date: "2026-06-18" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-06-18" });
    await insertRun({
      taskId: task.id,
      prUrl: "https://github.com/x/y/pull/4",
      status: "completed",
      outcome: JSON.stringify({ verdict: "approve" }),
    });
    const active = await runs.list({ goal: "<review>", taskId: task.id, activeOnly: true });
    expect(active).toHaveLength(0);
  });
});


describe("durable executor task ownership", () => {
  async function fixture() {
    const plan = await repo.createPlan({ title: "Owned plan" });
    const task = await repo.createTask({ planId: plan.id, title: "Owned task" });
    const executor = await insertRun({ goal: "<execute>", personaId: "executor", planId: plan.id, cwdStrategy: "repo" });
    return { plan, task, executor };
  }
  async function claim(taskId: string, runId: number) {
    return tool("transition_task").execute({ id: taskId, state: "in_progress", assignee: "executor" }, { author: "executor", runId });
  }

  it("claims through the existing transition tool and reserves the canonical branch", async () => {
    const { task, executor } = await fixture();
    expect((await claim(task.id, executor)).isError).toBeFalsy();
    expect(await repo.getTask(task.id)).toMatchObject({ executorRunId: executor, branch: `claude/${task.id.toLowerCase()}`, state: "in_progress" });
    expect((await claim(task.id, executor)).isError).toBeFalsy();
    expect(await runs.list()).toHaveLength(1);
    await expect(runs.create({ goal: "<implement>", taskId: task.id, defer: true })).rejects.toMatchObject({ status: 409 });
    await db.update(agentSessions).set({ status: "failed" }).where(eq(agentSessions.id, executor));
    await expect(runs.create({ goal: "<implement>", taskId: task.id, defer: true })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an executor claim when the task already has an active run", async () => {
    const { task, executor } = await fixture();
    await runs.create({ goal: "<implement>", taskId: task.id, defer: true });
    expect((await claim(task.id, executor)).isError).toBe(true);
    expect(await repo.getTask(task.id)).toMatchObject({ executorRunId: null, state: "todo" });
  });

  it("serializes a claim racing task-run creation", async () => {
    const { task, executor } = await fixture();
    const [ownership, session] = await Promise.allSettled([
      repo.transitionTask(task.id, { state: "in_progress", assignee: "executor", actorRunId: executor }),
      runs.create({ goal: "<implement>", taskId: task.id, defer: true }),
    ]);
    expect([ownership, session].filter(r => r.status === "fulfilled")).toHaveLength(1);
    const current = (await repo.getTask(task.id))!;
    expect((await runs.list({ taskId: task.id })).length).toBe(current.executorRunId == null ? 1 : 0);
  });

  it("serializes claims from two executors", async () => {
    const { plan, task, executor } = await fixture();
    const other = await insertRun({ goal: "<execute>", personaId: "executor", planId: plan.id });
    const claims = await Promise.all([claim(task.id, executor), claim(task.id, other)]);
    expect(claims.filter(r => !r.isError)).toHaveLength(1);
  });

  it("blocks renewal, local append and dispatch of an older task session", async () => {
    const { task, executor } = await fixture();
    const old = await insertRun({ goal: "<implement>", taskId: task.id, status: "failed", cwdStrategy: "worktree", branch: "claude/old", worktreePath: "/tmp/unopened-task" });
    expect((await claim(task.id, executor)).isError).toBeFalsy();
    await expect(runs.resumeTaskRunInPlace(old, { defer: true })).rejects.toMatchObject({ status: 409 });
    const frames = [];
    for await (const frame of runs.append({ runId: old, text: "continue", role: "user" })) frames.push(frame);
    expect(frames).toContainEqual(expect.objectContaining({ type: "error" }));
    expect(await runs.listMessages(old)).toHaveLength(0);
    await db.update(agentSessions).set({ status: "pending" }).where(eq(agentSessions.id, old));
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    const spawn = vi.fn(() => 1);
    expect(await dispatchRun(old, { spawn, admit: () => "admit" })).toBe("already-claimed");
    expect(spawn).not.toHaveBeenCalled();
    expect((await runs.get(old))!.workerScope).toBeNull();
  });

  it("ordinary channel transitions do not wait on dispatch's task admission lock", async () => {
    const { task } = await fixture();
    const session = await runs.create({ goal: "<implement>", taskId: task.id, defer: true });
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${task.id}))`);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          tool("transition_task").execute({ id: task.id, state: "in_progress", assignee: "implementor" }, { author: "implementor", runId: session.id }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Transition waited on dispatch task lock")), 1000); }),
        ]);
        expect(result.isError).toBeFalsy();
      } finally {
        clearTimeout(timeout);
      }
    });
    expect((await repo.getTask(task.id))!.executorRunId).toBeNull();
  });

  it("keeps ownership while blocked and releases it only when the task is terminal", async () => {
    const { task, executor } = await fixture();
    await claim(task.id, executor);
    await repo.transitionTask(task.id, { state: "blocked" });
    expect((await repo.getTask(task.id))!.executorRunId).toBe(executor);
    await repo.transitionTask(task.id, { state: "cancelled" });
    expect((await repo.getTask(task.id))!.executorRunId).toBeNull();
  });
});
