import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// start_session must stamp the spawner's userId onto the child
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

describe("start_session model resolution", () => {
  // A persona carries no model (migration 0031), so start_session passes none
  // and lets runs.create apply the deployment default. It used to pre-fill its
  // own bare-id DEFAULT_MODEL here, which shadowed that resolution.
  it("passes no model when start_session omits one", async () => {
    await repo.upsertPersona({
      id: "implementor",
      name: "Implementor",
      description: "",
      systemPrompt: "x",
      toolsProfile: "orchestrator,repo_write,gh_pr,gh_ci",
      skillPaths: [],
    });
    const plan = await repo.createPlan({ title: "Model resolution", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const spawnerId = await insertRun({ goal: "<execute>", planId: plan.id });
    createSpy.mockResolvedValue(fakeRunRow({ id: 5001, taskId: task.id }));

    await tool("start_session").execute(
      { task_id: task.id },
      { author: "test", runId: spawnerId }
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("still honors an explicit model passed to start_session", async () => {
    await repo.upsertPersona({
      id: "implementor",
      name: "Implementor",
      description: "",
      systemPrompt: "x",
      toolsProfile: "orchestrator,repo_write,gh_pr,gh_ci",
      skillPaths: [],
    });
    const plan = await repo.createPlan({ title: "Explicit model", date: "2026-07-04" });
    const task = await repo.createTask({ planId: plan.id, title: "Task", date: "2026-07-04" });
    const spawnerId = await insertRun({ goal: "<execute>", planId: plan.id });
    createSpy.mockResolvedValue(fakeRunRow({ id: 5002, taskId: task.id }));

    await tool("start_session").execute(
      { task_id: task.id, model: "anthropic/claude-opus-4-5" },
      { author: "test", runId: spawnerId }
    );

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-opus-4-5" })
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
