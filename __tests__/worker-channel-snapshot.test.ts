import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentSessions, personas as personasTable } from "../db/schema";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";
import { buildRunStart } from "../lib/worker-channel/snapshot";

const PERSONA_PROMPT = "You are the test implementor persona.";

beforeEach(async () => {
  await db.delete(agentSessions);
  await db.delete(personasTable);
  await repo.upsertPersona({
    id: "implementor",
    name: "Implementor",
    description: null,
    systemPrompt: PERSONA_PROMPT,
    toolsProfile: "orchestrator,planning,spawn",
    skillPaths: [],
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
  });
});

describe("buildRunStart", () => {
  it("builds a fresh chat snapshot with no task or plan", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const start = await buildRunStart(run.id);

    expect(start.mode).toBe("start");
    expect(start.run.id).toBe(run.id);
    expect(start.task).toBeNull();
    expect(start.plan).toBeNull();
    expect(start.persona.id).toBe("implementor");
    // The persona snapshot is prompt + tools + budget; the engine travels on
    // the run, not the persona (migration 0031).
    expect(start.persona).not.toHaveProperty("modelProvider");
    expect(start.run.model).toBe("anthropic/claude-opus-4-8");
    expect(start.repository).toBeTruthy();
    expect(Array.isArray(start.transcript)).toBe(true);
    expect(typeof start.memoryContext).toBe("string");
    expect(start.policy.allowedTools.length).toBeGreaterThan(0);
    // The profile flags contribute their tool families.
    expect(start.policy.allowedTools).toEqual([...start.policy.allowedTools].sort());
  });

  it("includes the task and plan for an implement run", async () => {
    const plan = await repo.createPlan({ title: "Snapshot Plan", date: "2026-07-02" });
    const task = await repo.createTask({ planId: plan.id, title: "Do the thing" });
    const run = await create({ goal: "<implement>", taskId: task.id, planId: plan.id, defer: true });

    const start = await buildRunStart(run.id);
    expect(start.task?.id).toBe(task.id);
    expect(start.plan?.id).toBe(plan.id);
  });

  it("orders the transcript and splits trailing user input into pendingInput", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    // user, agent, user, user — everything after the last agent turn is pending.
    const [u1] = await db
      .insert(agentMessages)
      .values({ runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "one" }]) })
      .returning({ id: agentMessages.id });
    const [a1] = await db
      .insert(agentMessages)
      .values({ runId: run.id, role: "agent", content: JSON.stringify([{ type: "text", text: "reply" }]) })
      .returning({ id: agentMessages.id });
    const [u2] = await db
      .insert(agentMessages)
      .values({ runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "two" }]) })
      .returning({ id: agentMessages.id });
    const [u3] = await db
      .insert(agentMessages)
      .values({ runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "three" }]) })
      .returning({ id: agentMessages.id });

    const start = await buildRunStart(run.id);
    expect(start.transcript.map((m) => m.id)).toEqual([u1.id, a1.id]);
    expect(start.pendingInput.map((m) => m.id)).toEqual([u2.id, u3.id]);
  });

  it("infers resume mode from a persisted SDK session id", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions).set({ sdkSessionId: "sess-123" }).where(eq(agentSessions.id, run.id));

    const start = await buildRunStart(run.id);
    expect(start.mode).toBe("resume");
  });

  it("honors an explicit mode override", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const start = await buildRunStart(run.id, "resume");
    expect(start.mode).toBe("resume");
  });

  it("throws for a missing run", async () => {
    await expect(buildRunStart(999999)).rejects.toThrow(/not found/i);
  });
});
