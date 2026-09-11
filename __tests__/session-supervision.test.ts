import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMessages, agentSessions, inboxEvents, runEventSubscriptions } from "../db/schema";
import * as runs from "../lib/runs";
import * as repo from "../lib/repo";
import { startSession } from "../lib/agent";
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { publishAttemptFinishedTx, registerDefaultChildSubscriptionTx } from "../lib/run-source-events";
import { repairReplacementSupervision } from "../lib/run-supervision-repair";

const realCreate = runs.create;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(runs, "create").mockImplementation(input => realCreate({ ...input, defer: true }));
});

async function fixture() {
  const parent = await runs.create({ goal: "<chat>", defer: true });
  const other = await runs.create({ goal: "<chat>", defer: true });
  const task = await repo.createTask({ planId: null, repoId: "R-default", title: "Replacement supervision" });
  const prior = await startSession({ taskId: task.id, parentRunId: parent.id });
  await db.update(agentSessions).set({ status: "failed", completedAt: new Date() }).where(eq(agentSessions.id, prior.id));
  return { parent, other, task, prior };
}

describe("replacement supervision", () => {
  it("exposes tool activity through the real get_session supervision entry point", async () => {
    const task = await repo.createTask({
      planId: null,
      repoId: "R-default",
      title: "Observe active tooling",
    });
    const child = await startSession({ taskId: task.id });
    await db.insert(agentMessages).values({
      runId: child.id,
      role: "agent",
      content: JSON.stringify([
        { type: "tool_use", id: "active-build", name: "Bash", input: { command: "private" } },
      ]),
    });
    const getSession = ORCHESTRATOR_TOOLS.find(t => t.name === "get_session")!;

    const response = await getSession.execute(
      { session_id: child.id, tail: 5 },
      { runId: 999, author: "executor" }
    );

    const body = JSON.parse(String(response.content[0].text));
    expect(body.activity.in_flight_tools).toEqual([
      expect.objectContaining({ tool_use_id: "active-build", tool_name: "Bash" }),
    ]);
    expect(JSON.stringify(body.activity)).not.toContain("private");
  });

  it("denies model-driven destructive cancellation of a task worktree", async () => {
    const parent = await runs.create({ goal: "<execute>", defer: true });
    const task = await repo.createTask({
      planId: null,
      repoId: "R-default",
      title: "Preserve unpublished work",
    });
    const child = await startSession({ taskId: task.id, parentRunId: parent.id });
    const cancel = ORCHESTRATOR_TOOLS.find(t => t.name === "cancel_session")!;

    const response = await cancel.execute(
      { session_id: child.id },
      { runId: parent.id, author: "executor" }
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Destructive cancellation denied");
    expect((await runs.get(child.id))?.status).not.toBe("cancelled");
  });

  it("keeps the original supervisor when another root retries a failed task without a resume token", async () => {
    const { parent, other, task, prior } = await fixture();
    const tool = ORCHESTRATOR_TOOLS.find(t => t.name === "start_session")!;
    const response = await tool.execute({ task_id: task.id }, { runId: other.id, author: "test" });
    expect(response.isError).toBeFalsy();
    const result = JSON.parse(response.content[0].text as string);
    expect(result).toMatchObject({ parent_run_id: parent.id, resume_of: prior.id });
    expect(result.message).toContain(`supervising run #${parent.id}`);
    const replacement = (await runs.get(result.session_id))!;
    expect(replacement.parentRunId).toBe(parent.id);
    expect(replacement.resumeOf).toBe(prior.id);
    const [sub] = await db.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.id, result.subscription_id));
    expect(sub.subscriberRunId).toBe(parent.id);
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: replacement.id, attempt: 1, status: "completed" }));
    const deliveries = await db.select().from(inboxEvents).where(eq(inboxEvents.sourceId, String(replacement.id)));
    expect(deliveries.map(d => d.targetRunId)).toEqual([parent.id]);
  });

  it("explicit resumes retain supervision and record retry lineage independently", async () => {
    const { parent, other, task, prior } = await fixture();
    const replacement = await startSession({ taskId: task.id, resumeOf: prior.id, parentRunId: other.id });
    expect(replacement).toMatchObject({ parentRunId: parent.id, resumeOf: prior.id });
    await expect(startSession({ taskId: task.id, resumeOf: replacement.id })).rejects.toMatchObject({ status: 409 });
  });

  it("preserves replacement settings and refuses a different task", async () => {
    const { task, prior } = await fixture();
    await db.update(agentSessions).set({ autoMerge: false, baseBranch: "develop", thinkingLevel: "high", budgetMaxTurns: 7 })
      .where(eq(agentSessions.id, prior.id));
    const another = await repo.createTask({ planId: null, repoId: "R-default", title: "Other task" });
    await expect(startSession({ taskId: another.id, resumeOf: prior.id })).rejects.toMatchObject({ status: 400 });
    const replacement = await startSession({ taskId: task.id });
    expect(await runs.get(replacement.id)).toMatchObject({ autoMerge: false, baseBranch: "develop", thinkingLevel: "high", budgetMaxTurns: 7 });
  });

  it("new task sessions use the caller and parentless retries stay parentless", async () => {
    const task = await repo.createTask({ planId: null, repoId: "R-default", title: "Root retry" });
    const caller = await runs.create({ goal: "<chat>", defer: true });
    const prior = await startSession({ taskId: task.id });
    expect(prior.resumeOf).toBeNull();
    await db.update(agentSessions).set({ status: "failed" }).where(eq(agentSessions.id, prior.id));
    const replacement = await startSession({ taskId: task.id, parentRunId: caller.id });
    expect(replacement.parentRunId).toBeNull();
  });

  it("repairs parent and subscriptions atomically without touching the worker", async () => {
    const { parent, other, task, prior } = await fixture();
    const [replacement] = await db.insert(agentSessions).values({
      goal: "<implement>", taskId: task.id, parentRunId: other.id, status: "running",
      workerScope: "existing-worker", deliveryVersion: 2,
    }).returning();
    const oldSub = await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, replacement));
    const input = { priorId: prior.id, replacementId: replacement.id, expectedParentId: other.id };
    expect((await repairReplacementSupervision(input)).applied).toBe(false);
    expect((await runs.get(replacement.id))?.parentRunId).toBe(other.id);
    await repairReplacementSupervision({ ...input, apply: true });
    expect(await runs.get(replacement.id)).toMatchObject({
      parentRunId: parent.id, resumeOf: prior.id, status: "running", workerScope: "existing-worker",
    });
    expect((await db.select().from(runEventSubscriptions).where(eq(runEventSubscriptions.id, oldSub.id)))[0].status).toBe("cancelled");
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: replacement.id, attempt: 1, status: "completed" }));
    const deliveries = await db.select().from(inboxEvents).where(eq(inboxEvents.sourceId, String(replacement.id)));
    expect(deliveries.map(d => d.targetRunId)).toEqual([parent.id]);
    await expect(repairReplacementSupervision({ ...input, apply: true })).rejects.toThrow("parent changed");
  });

  it("replays an already-published result to the correct parent without rewriting historical delivery", async () => {
    const { parent, other, task, prior } = await fixture();
    const [replacement] = await db.insert(agentSessions).values({ goal: "<implement>", taskId: task.id, parentRunId: other.id, status: "completed" }).returning();
    await db.transaction(tx => registerDefaultChildSubscriptionTx(tx, replacement));
    await db.transaction(tx => publishAttemptFinishedTx(tx, { id: replacement.id, attempt: 1, status: "completed" }));
    await repairReplacementSupervision({ priorId: prior.id, replacementId: replacement.id, expectedParentId: other.id, apply: true });
    expect((await runs.get(replacement.id))?.parentRunId).toBe(parent.id);
    const deliveries = await db.select().from(inboxEvents).where(eq(inboxEvents.sourceId, String(replacement.id)));
    expect(deliveries.map(d => d.targetRunId).sort()).toEqual([parent.id, other.id].sort());
  });

  it("refuses to move a replacement subtree", async () => {
    const { other, task, prior } = await fixture();
    const [replacement] = await db.insert(agentSessions).values({ goal: "<implement>", taskId: task.id, parentRunId: other.id }).returning();
    await db.insert(agentSessions).values({ goal: "<chat>", parentRunId: replacement.id });
    await expect(repairReplacementSupervision({ priorId: prior.id, replacementId: replacement.id, expectedParentId: other.id, apply: true })).rejects.toThrow("subtree repair");
    expect((await runs.get(replacement.id))?.parentRunId).toBe(other.id);
  });
});
