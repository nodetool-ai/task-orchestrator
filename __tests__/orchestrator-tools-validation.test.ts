import { ne } from "drizzle-orm";
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
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { validateToolArgs } from "../lib/tool-args";
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

// Insert an agent_runs row directly, bypassing the worker kickoff — mirrors
// the helper used in plan-executor.test.ts.
async function insertRun(
  values: Partial<typeof agentSessions.$inferInsert>
): Promise<number> {
  const row = await db
    .insert(agentSessions)
    .values({ goal: "<review>", status: "running", ...values })
    .returning();
  return row[0].id;
}

describe("validateToolArgs (TypeBox → Zod)", () => {
  it("rejects an unknown enum value", () => {
    const result = validateToolArgs(tool("create_plan"), { title: "X", state: "bogus" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/state/);
  });

  it("rejects a missing required field", () => {
    const result = validateToolArgs(tool("create_plan"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/title/);
  });

  it("rejects a wrong-typed field", () => {
    const result = validateToolArgs(tool("get_repository"), { id: 123 });
    expect(result.ok).toBe(false);
  });

  it("accepts valid args and passes them through", () => {
    const result = validateToolArgs(tool("create_plan"), { title: "X" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ title: "X" });
  });

  it("caches the converted schema per tool (repeat calls don't rebuild it)", () => {
    // Not directly observable from the outside, but at minimum repeated calls
    // must keep working and agree with each other.
    const a = validateToolArgs(tool("create_plan"), { title: "X" });
    const b = validateToolArgs(tool("create_plan"), { title: "X" });
    expect(a).toEqual(b);
  });
});

describe("create_plan initial-state restriction", () => {
  it("schema admits only 'draft' and 'proposed' as an initial state", () => {
    const t = tool("create_plan");
    expect(validateToolArgs(t, { title: "X", state: "draft" }).ok).toBe(true);
    expect(validateToolArgs(t, { title: "X", state: "proposed" }).ok).toBe(true);
    expect(validateToolArgs(t, { title: "X", state: "accepted" }).ok).toBe(false);
    expect(validateToolArgs(t, { title: "X", state: "done" }).ok).toBe(false);
    expect(validateToolArgs(t, { title: "X", state: "cancelled" }).ok).toBe(false);
  });
});

describe("await_session timeout_seconds bound", () => {
  it("schema carries a maximum of 7200", () => {
    const t = tool("await_session");
    const prop = (t.parameters as any).properties.timeout_seconds;
    expect(prop.minimum).toBe(1);
    expect(prop.maximum).toBe(7200);
  });

  it("rejects a timeout beyond the maximum", () => {
    const result = validateToolArgs(tool("await_session"), {
      session_id: 1,
      timeout_seconds: 1_000_000_000,
    });
    expect(result.ok).toBe(false);
  });
});

describe("start_review pr_url validation", () => {
  it("rejects an unparseable pr_url before touching the task", async () => {
    const res = await tool("start_review").execute(
      { task_id: "T-nope", pr_url: "not-a-pr-url" },
      ctx
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Could not parse pr_url/);
  });

  it("still reports task-not-found for a well-formed pr_url", async () => {
    const res = await tool("start_review").execute(
      { task_id: "T-nope", pr_url: "https://github.com/x/y/pull/2" },
      ctx
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/not found/);
  });
});

describe("delete_task refuses while an active run exists", () => {
  it("blocks deletion when a non-terminal run is attached to the task", async () => {
    const plan = await repo.createPlan({ title: "Delete Guard", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const runId = await insertRun({ taskId: task.id, status: "running" });

    const res = await tool("delete_task").execute({ id: task.id }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(new RegExp(`#${runId}`));

    // The task must still exist — the cascade never ran.
    expect(await repo.getTask(task.id)).not.toBeNull();
  });

  it("allows deletion once the run reaches a terminal status", async () => {
    const plan = await repo.createPlan({ title: "Delete Guard 2", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    await insertRun({ taskId: task.id, status: "completed" });

    const res = await tool("delete_task").execute({ id: task.id }, ctx);
    expect(res.isError).toBeFalsy();
    expect(await repo.getTask(task.id)).toBeNull();
  });
});

describe("delete_plan refuses while an active run exists", () => {
  it("blocks deletion when a non-terminal run is attached to a task in the plan", async () => {
    const plan = await repo.createPlan({ title: "Plan Delete Guard", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const runId = await insertRun({ taskId: task.id, status: "running" });

    const res = await tool("delete_plan").execute({ id: plan.id }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(new RegExp(`#${runId}`));

    expect(await repo.getPlan(plan.id)).not.toBeNull();
  });

  it("blocks deletion when a non-terminal run is attached to the plan itself", async () => {
    const plan = await repo.createPlan({ title: "Plan Delete Guard 2", date: "2026-07-04" });
    const runId = await insertRun({ planId: plan.id, status: "running" });

    const res = await tool("delete_plan").execute({ id: plan.id }, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(new RegExp(`#${runId}`));

    expect(await repo.getPlan(plan.id)).not.toBeNull();
  });

  it("allows deletion once all runs are terminal", async () => {
    const plan = await repo.createPlan({ title: "Plan Delete Guard 3", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    await insertRun({ taskId: task.id, status: "completed" });

    const res = await tool("delete_plan").execute({ id: plan.id }, ctx);
    expect(res.isError).toBeFalsy();
    expect(await repo.getPlan(plan.id)).toBeNull();
  });
});
