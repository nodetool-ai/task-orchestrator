// __tests__/extensions/planning.test.ts
//
// Unit tests for the planning tools extension.
// Two test groups:
//   1. Interceptor allow/deny per tool per stage (no DB needed for deny paths).
//   2. Tool execution (propose_spec, commit_spec_as_plan, propose_implementation_plan)
//      that require an in-process SQLite DB.

import { beforeEach, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { agentMessages, agentSessions, plans, repositories } from "../../db/schema";
import * as repo from "../../lib/repo";
import { planningExtension } from "../../lib/extensions/planning";
import { makeRegistrar } from "../helpers/fake-registrar";
import type { RunRow } from "../../lib/runs";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: 1,
    goal: "<chat>",
    status: "idle",
    origin: "chat",
    taskId: null,
    planId: null,
    repoId: null,
    parentRunId: null,
    toolsProfile: "orchestrator,repo_read,planning",
    cwdStrategy: "none",
    model: null,
    thinkingLevel: null,
    branch: null,
    worktreePath: null,
    prUrl: null,
    error: null,
    outcome: null,
    totalCostUsd: null,
    inputTokens: null,
    outputTokens: null,
    sdkSessionId: null,
    budgetMaxTurns: null,
    budgetMaxUsd: null,
    budgetMaxSeconds: null,
    userId: null,
    title: "My Planning Run",
    personaId: "planning-agent",
    legacyChatId: null,
    planningStage: "gathering",
    startedAt: new Date(),
    completedAt: null,
    heartbeatAt: null,
    workerScope: null,
    workerPid: null,
    cancelRequested: null,
    attempt: 1,
    result: null,
    parkReason: null,
    ...overrides,
  };
}

/** Install the planning extension with a given stage and return the registrar helper. */
function setup(stage: string | null, runId = 1) {
  const run = makeRun({ planningStage: stage, id: runId });
  const r = makeRegistrar();
  planningExtension({ runId, run })(r.reg);
  return r;
}

// ─── interceptor tests (no DB) ────────────────────────────────────────────────

describe("planningExtension interceptor — create_plan always denied", () => {
  const stages = [
    "gathering",
    "spec_review",
    "building_plan",
    "plan_review",
    "committing",
    "done",
  ] as const;

  for (const s of stages) {
    it(`blocks task_orch__create_plan in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({
        toolName: "task_orch__create_plan",
        input: { title: "Test" },
      });
      expect(result).toMatchObject({ block: true });
      expect((result as any).reason).toContain("commit_spec_as_plan");
    });
  }
});

describe("planningExtension interceptor — task write tools", () => {
  const writeTools = [
    "task_orch__create_task",
    "task_orch__update_task",
    "task_orch__transition_task",
  ];
  const blockedStages = ["gathering", "spec_review", "building_plan", "plan_review"];
  const allowedStages = ["committing", "done"];

  for (const tool of writeTools) {
    for (const s of blockedStages) {
      it(`blocks ${tool} in ${s}`, async () => {
        const r = setup(s);
        const result = await r.fireToolCall({ toolName: tool, input: {} });
        expect(result).toMatchObject({ block: true });
        expect((result as any).reason).toContain("committing");
      });
    }

    for (const s of allowedStages) {
      it(`allows ${tool} in ${s}`, async () => {
        const r = setup(s);
        const result = await r.fireToolCall({ toolName: tool, input: {} });
        expect(result).toBeUndefined();
      });
    }
  }
});

describe("planningExtension interceptor — propose_spec", () => {
  const validStages = ["gathering", "spec_review"];
  const invalidStages = ["building_plan", "plan_review", "committing", "done"];

  for (const s of validStages) {
    it(`allows propose_spec in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({
        toolName: "propose_spec",
        input: { title: "t", spec_markdown: "# spec" },
      });
      expect(result).toBeUndefined();
    });
  }

  for (const s of invalidStages) {
    it(`blocks propose_spec in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({
        toolName: "propose_spec",
        input: { title: "t", spec_markdown: "# spec" },
      });
      expect(result).toMatchObject({ block: true });
      expect((result as any).reason).toContain("gathering");
    });
  }
});

describe("planningExtension interceptor — commit_spec_as_plan", () => {
  it("allows commit_spec_as_plan in building_plan", async () => {
    const r = setup("building_plan");
    const result = await r.fireToolCall({ toolName: "commit_spec_as_plan", input: {} });
    expect(result).toBeUndefined();
  });

  const blockedStages = ["gathering", "spec_review", "plan_review", "committing", "done"];
  for (const s of blockedStages) {
    it(`blocks commit_spec_as_plan in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({ toolName: "commit_spec_as_plan", input: {} });
      expect(result).toMatchObject({ block: true });
      expect((result as any).reason).toContain("building_plan");
    });
  }
});

describe("planningExtension interceptor — propose_implementation_plan", () => {
  const validStages = ["building_plan", "plan_review"];
  const invalidStages = ["gathering", "spec_review", "committing", "done"];

  for (const s of validStages) {
    it(`allows propose_implementation_plan in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({
        toolName: "propose_implementation_plan",
        input: { tasks: [{ title: "T1", body: "b", criteria: ["c1"] }] },
      });
      expect(result).toBeUndefined();
    });
  }

  for (const s of invalidStages) {
    it(`blocks propose_implementation_plan in ${s}`, async () => {
      const r = setup(s);
      const result = await r.fireToolCall({
        toolName: "propose_implementation_plan",
        input: { tasks: [] },
      });
      expect(result).toMatchObject({ block: true });
      expect((result as any).reason).toContain("building_plan");
    });
  }
});

describe("planningExtension interceptor — unrelated tools are not blocked", () => {
  it("passes through task_orch__list_plans", async () => {
    const r = setup("gathering");
    const result = await r.fireToolCall({ toolName: "task_orch__list_plans", input: {} });
    expect(result).toBeUndefined();
  });

  it("passes through task_orch__get_plan", async () => {
    const r = setup("spec_review");
    const result = await r.fireToolCall({ toolName: "task_orch__get_plan", input: {} });
    expect(result).toBeUndefined();
  });
});

// ─── tool execution tests (need DB) ──────────────────────────────────────────

describe("planningExtension tool execution", () => {
  let runId: number;

  beforeEach(async () => {
    await db.delete(agentMessages);
    await db.delete(agentSessions);
    await db.delete(plans);
    await db.delete(repositories).where(ne(repositories.id, "R-default"));

    // Insert a real agent_runs row so the extension can UPDATE it.
    const row = (
      await db
        .insert(agentSessions)
        .values({
          goal: "<chat>",
          status: "idle",
          toolsProfile: "orchestrator,repo_read,planning",
          cwdStrategy: "none",
          planningStage: "gathering",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    runId = row!.id;
  });

  it("propose_spec advances stage from gathering to spec_review", async () => {
    const run = makeRun({ planningStage: "gathering", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);

    const tool = r.tools.get("propose_spec")!;
    const result = await tool.execute("call-1", {
      title: "My Spec",
      spec_markdown: "# Spec\nDo stuff.",
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Stop now");

    // Stage should have changed in DB.
    const row = (
      await db
        .select({ planningStage: agentSessions.planningStage })
        .from(agentSessions)
        .where(eq(agentSessions.id, runId))
    )[0];
    expect(row?.planningStage).toBe("spec_review");
  });

  it("propose_spec stays spec_review when already in spec_review", async () => {
    const run = makeRun({ planningStage: "spec_review", id: runId });
    await db.update(agentSessions)
      .set({ planningStage: "spec_review" })
      .where(eq(agentSessions.id, runId));

    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const tool = r.tools.get("propose_spec")!;
    await tool.execute("call-1", { title: "Revised", spec_markdown: "# v2" });

    const row = (await db.select().from(agentSessions)).find((r) => r.id === runId);
    expect(row?.planningStage).toBe("spec_review");
  });

  it("propose_implementation_plan advances stage from building_plan to plan_review", async () => {
    await db.update(agentSessions)
      .set({ planningStage: "building_plan" })
      .where(eq(agentSessions.id, runId));

    const run = makeRun({ planningStage: "building_plan", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const tool = r.tools.get("propose_implementation_plan")!;
    const result = await tool.execute("call-1", {
      tasks: [
        { title: "Task 1", body: "Do X", criteria: ["X is done"] },
        { title: "Task 2", body: "Do Y", criteria: ["Y is done"], dependencies: ["Task 1"] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as any).text).toContain("Stop now");

    const row = (await db.select().from(agentSessions)).find((r) => r.id === runId);
    expect(row?.planningStage).toBe("plan_review");
  });

  it("commit_spec_as_plan creates a draft plan with the spec body and writes planId", async () => {
    await db.update(agentSessions)
      .set({ planningStage: "building_plan" })
      .where(eq(agentSessions.id, runId));

    // Seed a propose_spec message into the agent_messages table.
    await db.insert(agentMessages)
      .values({
        runId,
        role: "agent",
        content: JSON.stringify([
          {
            type: "tool_use",
            name: "propose_spec",
            input: {
              title: "My Spec",
              spec_markdown: "# Spec\nWe will build something amazing.",
            },
          },
        ]),
        createdAt: new Date(),
      });

    const run = makeRun({ planningStage: "building_plan", id: runId, title: "My Planning Run" });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const tool = r.tools.get("commit_spec_as_plan")!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Created draft plan");

    // Extract plan id from result text.
    const match = text.match(/P-[\w-]+/);
    expect(match).toBeTruthy();
    const planId = match![0];

    // Plan should exist in DB with correct body and state.
    const plan = await repo.getPlan(planId);
    expect(plan).toBeTruthy();
    expect(plan!.state).toBe("draft");
    expect(plan!.body).toContain("We will build something amazing.");

    // Run should have planId set.
    const runRow = (await db.select().from(agentSessions)).find((r) => r.id === runId);
    expect(runRow?.planId).toBe(planId);
  });

  it("commit_spec_as_plan finds the spec when persisted with the Claude MCP name", async () => {
    // On the Claude backend, tool_use blocks are persisted verbatim with the
    // SDK-namespaced name `mcp__task_orch__propose_spec`. findLatestSpecMarkdown
    // must still locate the spec body (suffix match), otherwise stage 2 of the
    // guided planning flow is impossible and no plan can ever be committed.
    await db.update(agentSessions)
      .set({ planningStage: "building_plan" })
      .where(eq(agentSessions.id, runId));

    await db.insert(agentMessages)
      .values({
        runId,
        role: "agent",
        content: JSON.stringify([
          {
            type: "tool_use",
            name: "mcp__task_orch__propose_spec",
            input: { title: "My Spec", spec_markdown: "# Spec\nBuilt on the Claude backend." },
          },
        ]),
        createdAt: new Date(),
      });

    const run = makeRun({ planningStage: "building_plan", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const result = await r.tools.get("commit_spec_as_plan")!.execute("call-1", {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Created draft plan");
    const planId = text.match(/P-[\w-]+/)![0];
    expect((await repo.getPlan(planId))!.body).toContain("Built on the Claude backend.");
  });

  it("commit_spec_as_plan errors when no propose_spec message found", async () => {
    await db.update(agentSessions)
      .set({ planningStage: "building_plan" })
      .where(eq(agentSessions.id, runId));

    const run = makeRun({ planningStage: "building_plan", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const tool = r.tools.get("commit_spec_as_plan")!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("no propose_spec");
  });

  it("commit_spec_as_plan uses custom title when provided", async () => {
    await db.update(agentSessions)
      .set({ planningStage: "building_plan" })
      .where(eq(agentSessions.id, runId));

    await db.insert(agentMessages)
      .values({
        runId,
        role: "agent",
        content: JSON.stringify([
          {
            type: "tool_use",
            name: "propose_spec",
            input: { title: "Original Title", spec_markdown: "# Spec\nContent." },
          },
        ]),
        createdAt: new Date(),
      });

    const run = makeRun({ planningStage: "building_plan", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);
    const tool = r.tools.get("commit_spec_as_plan")!;
    const result = await tool.execute("call-1", { title: "Custom Title" });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("Custom Title");
  });

  it("within-turn stage mutation: propose_spec then interceptor sees spec_review", async () => {
    const run = makeRun({ planningStage: "gathering", id: runId });
    const r = makeRegistrar();
    planningExtension({ runId, run })(r.reg);

    // Call propose_spec tool — this should advance stage to spec_review in memory.
    const tool = r.tools.get("propose_spec")!;
    await tool.execute("call-1", { title: "T", spec_markdown: "# s" });

    // Now the interceptor for propose_spec should still allow (spec_review is valid).
    const interceptResult = await r.fireToolCall({
      toolName: "propose_spec",
      input: { title: "T2", spec_markdown: "# s2" },
    });
    expect(interceptResult).toBeUndefined();

    // But commit_spec_as_plan should be blocked (not in building_plan yet).
    const blockResult = await r.fireToolCall({
      toolName: "commit_spec_as_plan",
      input: {},
    });
    expect(blockResult).toMatchObject({ block: true });
  });
});

// ─── repo.setPlanningStage ────────────────────────────────────────────────────

describe("repo.setPlanningStage", () => {
  let runId: number;

  beforeEach(async () => {
    await db.delete(agentMessages);
    await db.delete(agentSessions);
    const row = (
      await db
        .insert(agentSessions)
        .values({
          goal: "<chat>",
          status: "idle",
          toolsProfile: "orchestrator,repo_read,planning",
          cwdStrategy: "none",
          planningStage: "gathering",
          startedAt: new Date(),
        })
        .returning({ id: agentSessions.id })
    )[0];
    runId = row!.id;
  });

  it("updates planning_stage in the DB", async () => {
    await repo.setPlanningStage(runId, "spec_review");
    const row = (await db.select().from(agentSessions)).find((r) => r.id === runId);
    expect(row?.planningStage).toBe("spec_review");
  });

  it("can advance through the full stage sequence", async () => {
    const stages: repo.PlanningStage[] = [
      "spec_review",
      "building_plan",
      "plan_review",
      "committing",
      "done",
    ];
    for (const s of stages) {
      await repo.setPlanningStage(runId, s);
      const row = (await db.select().from(agentSessions)).find((r) => r.id === runId);
      expect(row?.planningStage).toBe(s);
    }
  });
});

// ─── profile resolves ─────────────────────────────────────────────────────────

describe("planning profile resolves in lib/profiles.ts", () => {
  it("resolveProfiles includes planning profile", async () => {
    const { resolveProfiles } = await import("../../lib/profiles");
    const run = makeRun({ planningStage: "gathering", id: 1 });
    const ctx = {
      runId: 1,
      run,
      author: "test",
      taskId: null,
      planId: null,
      cwd: "/tmp",
    };
    const resolved = await resolveProfiles("planning", ctx);
    // Should produce exactly one factory.
    expect(resolved.factories.length).toBe(1);
    // Should not grant repo write access.
    expect(resolved.allowsRepoWrite).toBe(false);
  });

  it("resolveProfiles throws on unknown profile", async () => {
    const { resolveProfiles } = await import("../../lib/profiles");
    const run = makeRun({ id: 1 });
    const ctx = { runId: 1, run, author: "test", taskId: null, planId: null, cwd: "/tmp" };
    await expect(resolveProfiles("nonexistent_profile", ctx)).rejects.toThrow(
      "Unknown tools profile"
    );
  });
});
