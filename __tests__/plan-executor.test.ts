import { eq, ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
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
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { buildExecutePrompt } from "../lib/run-templates";
import { PERSONAS } from "../lib/personas";
import { seedPersonas } from "../db/seed-personas";

beforeEach(async () => {
  // Personas back the agent_runs.persona_id FK; seed before any run insert.
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
  it("is registered with the spawn profile", () => {
    const p = PERSONAS.find((x) => x.id === "executor");
    expect(p).toBeDefined();
    expect(p!.toolsProfile).toContain("orchestrator");
    expect(p!.toolsProfile).toContain("gh_pr");
    expect(p!.toolsProfile).toContain("spawn");
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

  it("defers cleanly with cwd=none (no checkout) and the spawn-enabled default profile", async () => {
    const plan = await repo.createPlan({ title: "Deferred", date: "2026-06-18" });
    const run = await runs.create({ goal: "<execute>", planId: plan.id, defer: true });
    expect(run.goal).toBe("<execute>");
    expect(run.cwdStrategy).toBe("none");
    expect(run.toolsProfile).toContain("spawn");
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

  it("resolves once a running session reaches a terminal status", async () => {
    const id = await insertRun({ status: "running" });
    // Flip to completed shortly after the poll loop starts.
    setTimeout(async () => {
      await db
        .update(agentSessions)
        .set({ status: "completed", outcome: JSON.stringify({ verdict: "request_changes" }) })
        .where(eq(agentSessions.id, id));
    }, 100);
    const res = await tool("await_session").execute({ session_id: id }, ctx);
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.status).toBe("completed");
    expect(out.verdict).toBe("request_changes");
  });
});

describe("start_review", () => {
  it("errors when the task is unknown", async () => {
    const res = await tool("start_review").execute(
      { task_id: "T-nope", pr_url: "https://github.com/x/y/pull/2" },
      ctx
    );
    expect(res.isError).toBe(true);
  });

  it("refuses to start a second review while one is already active on the task", async () => {
    const plan = await repo.createPlan({ title: "Review Guard", date: "2026-06-18" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-06-18" });
    await insertRun({
      taskId: task.id,
      prUrl: "https://github.com/x/y/pull/3",
      status: "running",
    });
    const res = await tool("start_review").execute(
      { task_id: task.id, pr_url: "https://github.com/x/y/pull/3" },
      ctx
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/already has an active review/);
  });

  it("the active-review guard only counts non-terminal runs (unit-level check)", async () => {
    // Exercise runs.list's activeOnly filtering directly rather than through
    // start_review's execute path — a terminal prior review must not count,
    // but driving that via the real tool would fire start_review's
    // fire-and-forget runs.create(...) side effects (real worktree/gh calls)
    // against the shared test repo, which we want to avoid in this suite.
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
