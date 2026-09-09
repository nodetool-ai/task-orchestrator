import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, inboxEvents, runEventSubscriptions, runSourceEvents, runTimers } from "../db/schema";
import { seedPersonas } from "../db/seed-personas";
import { fireDueTimers } from "../lib/inbox";

async function makeRun(questionState: "open" | "answered" = "open") {
  const [row] = await db.insert(agentSessions).values({
    goal: "<chat>", status: "parked", personaId: "implementor", startedAt: new Date(),
    parkReason: "question",
    pendingQuestion: {
      question_id: "q-deadline-test", question: "Proceed?", state: questionState,
      asked_at: new Date(Date.now() - 60_000).toISOString(),
    },
  }).returning({ id: agentSessions.id });
  return row.id;
}

beforeEach(async () => {
  await seedPersonas();
  await db.delete(inboxEvents);
  await db.delete(runEventSubscriptions);
  await db.delete(runSourceEvents);
  await db.delete(runTimers);
  await db.delete(agentSessions);
});

describe("question deadline event publication", () => {
  it("expires an open question and publishes timer plus canonical resolution once", async () => {
    const runId = await makeRun();
    const fireAt = new Date(Date.now() - 1_000);
    const [timer] = await db.insert(runTimers).values({
      runId, fireAt, note: "deadline", correlationId: "q-deadline-test", status: "pending",
    }).returning({ id: runTimers.id });

    expect(await fireDueTimers(new Date())).toBe(1);
    expect(await fireDueTimers(new Date())).toBe(0);

    const question = (await db.select({ pending: agentSessions.pendingQuestion }).from(agentSessions).where(eq(agentSessions.id, runId)))[0].pending;
    expect((question as any).state).toBe("expired");
    expect((await db.select().from(runTimers).where(eq(runTimers.id, timer.id)))[0].status).toBe("fired");
    expect((await db.select().from(inboxEvents).where(and(eq(inboxEvents.targetRunId, runId), eq(inboxEvents.sourceId, String(timer.id)))))).toHaveLength(1);
    const facts = await db.select().from(runSourceEvents).where(eq(runSourceEvents.sourceRunId, runId));
    expect(facts.filter((fact) => fact.eventType === "run.question_resolved")).toHaveLength(1);
  });

  it("does not overwrite an answered question or publish a timeout resolution", async () => {
    const runId = await makeRun("answered");
    await db.insert(runTimers).values({
      runId, fireAt: new Date(Date.now() - 1_000), note: "deadline", correlationId: "q-deadline-test", status: "pending",
    });
    expect(await fireDueTimers(new Date())).toBe(1);
    const question = (await db.select({ pending: agentSessions.pendingQuestion }).from(agentSessions).where(eq(agentSessions.id, runId)))[0].pending;
    expect((question as any).state).toBe("answered");
    const facts = await db.select().from(runSourceEvents).where(eq(runSourceEvents.sourceRunId, runId));
    expect(facts.filter((fact) => fact.eventType === "run.question_resolved")).toHaveLength(0);
  });
});
