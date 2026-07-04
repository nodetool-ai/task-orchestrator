import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// start_session / start_review must stamp the spawner's userId onto the child
// via runs.create. Mock ONLY runs.create — the real one fires fire-and-forget
// worker kickoffs (worktree/gh calls) we must not run in this suite; everything
// else (runs.get, runs.list, hydration) stays real so the tools' lookup of the
// spawning run exercises the actual DB path.
const createSpy = vi.hoisted(() => vi.fn());
vi.mock("../lib/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runs")>();
  return { ...actual, create: createSpy };
});

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
  users,
} from "../db/schema";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { seedPersonas } from "../db/seed-personas";

beforeEach(async () => {
  createSpy.mockReset();
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
  await db.delete(users);
  await db.delete(repositories).where(ne(repositories.id, "R-default"));
});

function tool(name: string) {
  const t = ORCHESTRATOR_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not in registry`);
  return t;
}

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

async function insertUser(email: string): Promise<number> {
  const row = await db
    .insert(users)
    .values({ email, passwordHash: "x" })
    .returning();
  return row[0].id;
}

// Minimal RunRow-shaped value for the mocked create; startSession feeds it
// through the real toAgentSessionFull, which needs a non-null taskId.
function fakeRunRow(overrides: { id: number; taskId: string }) {
  return {
    ...overrides,
    status: "pending",
    model: "test-model",
    branch: null,
    worktreePath: null,
    prUrl: null,
    error: null,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    sdkSessionId: null,
    parentRunId: null,
    repoId: null,
    startedAt: new Date(),
    completedAt: null,
  };
}

describe("start_review userId propagation", () => {
  it("stamps the spawner's userId onto the child run", async () => {
    const userId = await insertUser("spawner@example.com");
    const plan = await repo.createPlan({ title: "Attribution", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const spawnerId = await insertRun({ goal: "<execute>", planId: plan.id, userId });
    createSpy.mockResolvedValue(fakeRunRow({ id: 4242, taskId: task.id }));

    const res = await tool("start_review").execute(
      { task_id: task.id, pr_url: "https://github.com/x/y/pull/9" },
      { author: "test", runId: spawnerId }
    );
    expect(res.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "<review>",
        taskId: task.id,
        parentRunId: spawnerId,
        userId,
      })
    );
  });

  it("passes userId=null when the tool runs outside a run (no ctx.runId)", async () => {
    const plan = await repo.createPlan({ title: "No Spawner", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    createSpy.mockResolvedValue(fakeRunRow({ id: 4243, taskId: task.id }));

    const res = await tool("start_review").execute(
      { task_id: task.id, pr_url: "https://github.com/x/y/pull/10" },
      { author: "test" }
    );
    expect(res.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, parentRunId: null })
    );
  });
});

describe("start_session userId propagation", () => {
  it("threads the spawner's userId through startSession into runs.create", async () => {
    const userId = await insertUser("executor@example.com");
    const plan = await repo.createPlan({ title: "Attribution 2", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const spawnerId = await insertRun({ goal: "<execute>", planId: plan.id, userId });
    createSpy.mockResolvedValue(fakeRunRow({ id: 4244, taskId: task.id }));

    const res = await tool("start_session").execute(
      { task_id: task.id },
      { author: "test", runId: spawnerId }
    );
    expect(res.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: "<implement>",
        taskId: task.id,
        parentRunId: spawnerId,
        userId,
      })
    );
  });
});

describe("runs.list parentRunId filter", () => {
  it("returns only the children of the given run, not siblings or the parent", async () => {
    const parentId = await insertRun({ goal: "<execute>", status: "running" });
    const otherParentId = await insertRun({ goal: "<execute>", status: "running" });
    const childA = await insertRun({ parentRunId: parentId, status: "completed" });
    const childB = await insertRun({ parentRunId: parentId, status: "running" });
    await insertRun({ parentRunId: otherParentId, status: "running" });
    await insertRun({ status: "running" }); // no parent at all

    const children = await runs.list({ parentRunId: parentId });
    expect(children.map((c) => c.id).sort((a, b) => a - b)).toEqual([childA, childB]);
    expect(children.every((c) => c.parentRunId === parentId)).toBe(true);
  });
});
