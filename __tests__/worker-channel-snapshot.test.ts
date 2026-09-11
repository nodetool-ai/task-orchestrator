import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentSessions, inboxEvents, personas as personasTable, runEventSubscriptions, runSourceEvents } from "../db/schema";
import * as repo from "../lib/repo";
import { create } from "../lib/runs";
import { buildRunStart } from "../lib/worker-channel/snapshot";
import { RESUME_SNAPSHOT_BYTES } from "../lib/worker-channel/resume-transcript";

const PERSONA_PROMPT = "You are the test implementor persona.";

beforeEach(async () => {
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(agentMessages);
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
    // The persona snapshot carries an optional model default; the run records
    // the resolved engine/model values actually used.
    expect(start.persona).toHaveProperty("model", null);
    expect(start.run.model).toBe("anthropic/claude-opus-4-8");
    expect(start.repository).toBeTruthy();
    expect(Array.isArray(start.transcript)).toBe(true);
    expect(typeof start.memoryContext).toBe("string");
    expect(start.policy.allowedTools.length).toBeGreaterThan(0);
    expect(start.policy.allowedTools).toEqual(expect.arrayContaining([
      "codeact_catalog",
      "codeact_execute",
    ]));
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

  it("carries disabled auto-merge policy into the worker implement prompt", async () => {
    const task = await repo.createTask({ planId: null, title: "No merge", repoId: "R-default" });
    const run = await create({ goal: "<implement>", taskId: task.id, repoId: "R-default", autoMerge: false, defer: true });
    const start = await buildRunStart(run.id);
    expect(JSON.stringify(start.pendingInput)).toContain("Auto-merge is disabled for this run");
    expect(run.baseBranch).toBe("main");
    expect(start.run.baseBranch).toBe("main");
  });

  it("carries a persisted base branch into the detached worker snapshot", async () => {
    const task = await repo.createTask({ planId: null, title: "Release branch", repoId: "R-default" });
    const run = await create({ goal: "<implement>", taskId: task.id, repoId: "R-default", baseBranch: "release", defer: true });
    const start = await buildRunStart(run.id);
    expect(run.baseBranch).toBe("release");
    expect(start.run.baseBranch).toBe("release");
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

  it("bounds durable recovery history even when the backend has no SDK token", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const content = JSON.stringify([{ type: "text", text: "tool history ".repeat(15_000) }]);
    await db.insert(agentMessages).values(Array.from({ length: 12 }, (_, i) => ({
      runId: run.id,
      role: i % 3 === 1 ? "agent" as const : i % 3 === 2 ? "tool" as const : "user" as const,
      content,
    })));
    const [pending] = await db.insert(agentMessages).values({
      runId: run.id,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "continue exactly once" }]),
    }).returning({ id: agentMessages.id });

    const start = await buildRunStart(run.id);

    expect(start.mode).toBe("resume");
    expect(start.run.sdkSessionId).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThanOrEqual(RESUME_SNAPSHOT_BYTES);
    expect(start.transcriptOmittedMessages).toBeGreaterThan(0);
    expect(start.pendingInput.map(message => message.id)).toEqual([pending.id]);
  });

  it("honors an explicit mode override", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const start = await buildRunStart(run.id, "resume");
    expect(start.mode).toBe("resume");
  });

  it("bounds resumed history without deleting stored messages or changing pending inputs", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    await db.update(agentSessions).set({ sdkSessionId: "retained-session" }).where(eq(agentSessions.id, run.id));
    const content = JSON.stringify([{ type: "text", text: "history ".repeat(20_000) }]);
    await db.insert(agentMessages).values(Array.from({ length: 10 }, (_, i) => ({
      runId: run.id, role: i % 2 ? "agent" as const : "user" as const, content,
    })));
    const [pending] = await db.insert(agentMessages).values({
      runId: run.id, role: "user", content: JSON.stringify([{ type: "text", text: "whats status" }]),
    }).returning({ id: agentMessages.id });

    const start = await buildRunStart(run.id);
    expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThanOrEqual(RESUME_SNAPSHOT_BYTES);
    expect(start.transcriptOmittedMessages).toBeGreaterThan(0);
    expect(start.pendingInput.map(message => message.id)).toEqual([pending.id]);
    const stored = await db.select().from(agentMessages).where(eq(agentMessages.runId, run.id));
    expect(stored).toHaveLength(11);
    expect(stored.filter(message => message.content === content)).toHaveLength(10);
  });

  it("throws for a missing run", async () => {
    await expect(buildRunStart(999999)).rejects.toThrow(/not found/i);
  });

  it("builds a v2 kickoff snapshot from one claimed manifest", async () => {
    const run = await create({ goal: "<chat>", initialPrompt: "start", defer: true });
    await db.update(agentSessions).set({ deliveryVersion: 2 }).where(eq(agentSessions.id, run.id));
    const first = await buildRunStart(run.id);
    expect(first.kickoffPrompt).toBeUndefined();
    expect(first.turnId).toBeTruthy();
    expect(first.inputManifest?.map((input) => input.messageId)).toEqual(first.pendingInput.map((message) => message.id));
    expect(new Set(first.pendingInput.map((message) => message.id)).size).toBe(first.pendingInput.length);
  });

  it("replays the same uncompleted v2 manifest on a second snapshot", async () => {
    const run = await create({ goal: "<chat>", initialPrompt: "start", defer: true });
    await db.update(agentSessions).set({ deliveryVersion: 2 }).where(eq(agentSessions.id, run.id));
    const first = await buildRunStart(run.id);
    const second = await buildRunStart(run.id);
    expect(second.turnId).toBe(first.turnId);
    expect(second.inputManifest).toEqual(first.inputManifest);
    expect(second.pendingInput.map((message) => message.id)).toEqual(first.pendingInput.map((message) => message.id));
    expect(second.transcript.some((message) => first.pendingInput.some((pending) => pending.id === message.id))).toBe(false);
  });
});
