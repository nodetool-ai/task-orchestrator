import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { agentEvents, agentMessages, agentSessions, runSchedules, scheduleOccurrences, tasks } from "../db/schema";
import * as schedules from "../lib/schedules";
import * as repo from "../lib/repo";
import * as runs from "../lib/runs";
import * as agent from "../lib/agent";

const clock = (at: string) => ({ now: () => new Date(at) });

beforeEach(async () => {
  await db.delete(agentMessages); await db.delete(agentEvents); await db.delete(agentSessions);
  await db.delete(tasks); await db.delete(scheduleOccurrences); await db.delete(runSchedules);
});

describe("schedule cadence and durable claims", () => {
  it("uses cron-parser's timezone-aware DST cadence", () => {
    const next = schedules.nextCadenceAt(
      { kind: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York", intervalSeconds: null },
      new Date("2026-03-07T15:00:00.000Z")
    );
    expect(next.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("saves an empty-start interval with an immediate first occurrence", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const schedule = await schedules.createSchedule({ name: "hourly", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 3600 }, clock(now.toISOString()));
    expect(schedule.nextRunAt?.toISOString()).toBe(now.toISOString());
  });

  it("claims only the latest interval missed during downtime without enumerating intervals", async () => {
    const schedule = await schedules.createSchedule({ name: "hourly", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 3600, startAt: new Date("2000-01-01T00:00:00Z") }, clock("2000-01-01T00:00:00Z"));
    const ids = await schedules.claimDueSchedules(clock("2026-01-01T04:30:00Z"));
    expect(ids).toHaveLength(1);
    const occurrence = (await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, ids[0])))[0];
    expect(occurrence.scheduledFor.toISOString()).toBe("2026-01-01T04:00:00.000Z");
    const refreshed = (await db.select().from(runSchedules).where(eq(runSchedules.id, schedule.id)))[0];
    expect(refreshed.nextRunAt?.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("uses bounded previous/next cron evaluation for latest-only catch-up", async () => {
    const schedule = await schedules.createSchedule({ name: "cron", prompt: "work", repoId: "R-default", kind: "cron", cronExpression: "0 * * * *" }, clock("2026-01-01T00:00:00Z"));
    const [id] = await schedules.claimDueSchedules(clock("2026-01-01T04:30:00Z"));
    const occurrence = (await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, id)))[0];
    expect(occurrence.scheduledFor.toISOString()).toBe("2026-01-01T04:00:00.000Z");
    expect((await schedules.getSchedule(schedule.id))!.nextRunAt?.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("serializes concurrent sweepers into one occurrence", async () => {
    const schedule = await schedules.createSchedule({ name: "once", prompt: "work", repoId: "R-default", kind: "once", runAt: new Date("2026-01-01T00:00:00Z") }, clock("2025-12-31T00:00:00Z"));
    const [a, b] = await Promise.all([schedules.claimDueSchedules(clock("2026-01-01T00:01:00Z")), schedules.claimDueSchedules(clock("2026-01-01T00:01:00Z"))]);
    expect(a.length + b.length).toBe(1);
    expect(await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.scheduleId, schedule.id))).toHaveLength(1);
  });

  it("honors another durable launching reservation and leaves terminal occurrences alone", async () => {
    const schedule = await schedules.createSchedule({ name: "interval", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 60 }, clock("2026-01-01T00:00:00Z"));
    const now = new Date("2026-01-01T00:00:00Z");
    const [owner, contender, terminal] = await db.insert(scheduleOccurrences).values([
      { scheduleId: schedule.id, scheduledFor: now, status: "launching", launchToken: "owner", launchClaimedAt: now, createdAt: now, updatedAt: now },
      { scheduleId: schedule.id, scheduledFor: new Date("2026-01-01T00:01:00Z"), status: "pending", createdAt: now, updatedAt: now },
      { scheduleId: schedule.id, scheduledFor: new Date("2026-01-01T00:02:00Z"), status: "failed", createdAt: now, updatedAt: now },
    ]).returning();
    await schedules.launchOccurrence(contender.id, clock("2026-01-01T00:00:01Z"));
    await schedules.launchOccurrence(terminal.id, clock("2026-01-01T00:00:01Z"));
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, owner.id)))[0].status).toBe("launching");
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, contender.id)))[0].status).toBe("skipped");
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, terminal.id)))[0].status).toBe("failed");
    expect(await db.select().from(tasks)).toHaveLength(0);
  });

  it("starts newly created scheduled tasks through the canonical lifecycle", async () => {
    const realStart = agent.startSession;
    const start = vi.spyOn(agent, "startSession").mockImplementation((input) =>
      realStart({ ...input, defer: true })
    );
    try {
      const schedule = await schedules.createSchedule({ name: "once", prompt: "work", repoId: "R-default", kind: "once", runAt: new Date("2026-01-01T00:00:00Z") }, clock("2025-12-31T00:00:00Z"));
      const occurrenceId = await schedules.runScheduleNow(schedule.id, clock("2026-01-01T00:00:00Z"));
      const task = (await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId)))[0]!;

      expect(await repo.getTask(task.id)).toMatchObject({ state: "in_progress", assignee: "claude-agent" });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id }));
    } finally {
      start.mockRestore();
    }
  });

  it("recovers existing task/run links without regressing their lifecycle and emits scheduled_run exactly once", async () => {
    const schedule = await schedules.createSchedule({ name: "once", prompt: "work", repoId: "R-default", kind: "once", runAt: new Date("2026-01-01T00:00:00Z") }, clock("2025-12-31T00:00:00Z"));
    const [occurrenceId] = await schedules.claimDueSchedules(clock("2026-01-01T00:00:00Z"));
    const task = await repo.createTask({ planId: null, title: "recovered", repoId: "R-default", scheduleOccurrenceId: occurrenceId });
    const run = await runs.create({ goal: "<implement>", cwdStrategy: "worktree", taskId: task.id, repoId: "R-default", scheduleOccurrenceId: occurrenceId, autoMerge: false, defer: true });
    await schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:01:00Z"));
    await schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:02:00Z"));
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)))[0].status).toBe("launched");
    expect(await repo.getTask(task.id)).toMatchObject({ state: "in_progress", assignee: "claude-agent" });
    expect(await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId))).toHaveLength(1);
    expect(await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId))).toHaveLength(1);
    expect(await db.select().from(agentEvents).where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "scheduled_run")))).toHaveLength(1);
  });

  it("does not regress a terminal task during scheduled recovery", async () => {
    const schedule = await schedules.createSchedule({ name: "once", prompt: "work", repoId: "R-default", kind: "once", runAt: new Date("2026-01-01T00:00:00Z") }, clock("2025-12-31T00:00:00Z"));
    const [occurrenceId] = await schedules.claimDueSchedules(clock("2026-01-01T00:00:00Z"));
    const task = await repo.createTask({ planId: null, title: "terminal recovered", repoId: "R-default", scheduleOccurrenceId: occurrenceId });
    const run = await runs.create({ goal: "<implement>", cwdStrategy: "worktree", taskId: task.id, repoId: "R-default", scheduleOccurrenceId: occurrenceId, autoMerge: false, defer: true });
    await repo.transitionTask(task.id, { state: "in_progress", assignee: "operator" });
    await repo.transitionTask(task.id, { state: "merged" });

    await schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:01:00Z"));

    expect(await repo.getTask(task.id)).toMatchObject({ state: "merged", assignee: "operator" });
    expect(await db.select().from(agentEvents).where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "scheduled_run")))).toHaveLength(1);
  });

  it("does not steal a task-linked live lease and fences a stale finalizer", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const schedule = await schedules.createSchedule({ name: "release", prompt: "work", repoId: "R-default", baseBranch: "release", kind: "once", runAt: now }, clock("2025-12-31T00:00:00Z"));
    const [occurrenceId] = await schedules.claimDueSchedules(clock(now.toISOString()));
    const task = await repo.createTask({ planId: null, title: "created by owner A", repoId: "R-default", scheduleOccurrenceId: occurrenceId });
    await db.update(scheduleOccurrences).set({ status: "launching", launchToken: "owner-a", launchClaimedAt: now }).where(eq(scheduleOccurrences.id, occurrenceId));

    // Reconciliation cannot take a non-expired claim merely because the task
    // idempotency link already exists.
    await schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:01:00Z"));
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)))[0].launchToken).toBe("owner-a");

    const realStart = agent.startSession;
    let releaseOwnerA!: () => void;
    const ownerAStopped = new Promise<void>((resolve) => { releaseOwnerA = resolve; });
    let firstStarted!: () => void;
    const ownerAStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    let calls = 0;
    const start = vi.spyOn(agent, "startSession").mockImplementation(async (input) => {
      calls += 1;
      const session = await realStart({ ...input, defer: true });
      if (calls === 1) {
        firstStarted();
        await ownerAStopped;
      }
      return session;
    });
    try {
      // A's expired lease is recovered by B. Both use the canonical start path,
      // but the test forces deferred mode so no agent/worker process starts.
      const ownerA = schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:06:00Z"));
      await ownerAStarted;
      expect(start.mock.calls[0][0].baseBranch).toBe("release");
      await schedules.launchOccurrence(occurrenceId, clock("2026-01-01T00:12:00Z"));
      const run = (await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId)))[0]!;
      expect(run.baseBranch).toBe("release");
      await db.update(scheduleOccurrences).set({ status: "failed", error: "B failed after finalizing" }).where(eq(scheduleOccurrences.id, occurrenceId));
      releaseOwnerA();
      await ownerA;

      const occurrence = (await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)))[0];
      expect(occurrence.status).toBe("failed");
      expect(await db.select().from(agentEvents).where(and(eq(agentEvents.sessionId, run.id), eq(agentEvents.type, "scheduled_run")))).toHaveLength(1);
      expect(await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId))).toHaveLength(1);
      expect(task.id).toBeTruthy();
    } finally {
      start.mockRestore();
    }
  });

  it("treats an idle linked run as overlapping work", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const schedule = await schedules.createSchedule({ name: "interval", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 60 }, clock(now.toISOString()));
    const [active, contender] = await db.insert(scheduleOccurrences).values([
      { scheduleId: schedule.id, scheduledFor: now, status: "launched", createdAt: now, updatedAt: now },
      { scheduleId: schedule.id, scheduledFor: new Date("2026-01-01T00:01:00Z"), status: "pending", createdAt: now, updatedAt: now },
    ]).returning();
    const task = await repo.createTask({ planId: null, title: "idle run", repoId: "R-default", scheduleOccurrenceId: active.id });
    await runs.create({ goal: "<implement>", cwdStrategy: "worktree", taskId: task.id, repoId: "R-default", scheduleOccurrenceId: active.id, defer: true });
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.scheduleOccurrenceId, active.id));

    await schedules.launchOccurrence(contender.id, clock("2026-01-01T00:01:00Z"));
    expect((await db.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, contender.id)))[0].status).toBe("skipped");
  });

  it("inherits selected persona tools and budgets fieldwise while keeping schedule overrides", async () => {
    await repo.upsertPersona({ id: "scheduled-persona", name: "Scheduled", systemPrompt: "test", toolsProfile: "orchestrator", skillPaths: [], budgetMaxTurns: 11, budgetMaxSeconds: 22 });
    const task = await repo.createTask({ planId: null, title: "persona defaults", repoId: "R-default" });
    const session = await agent.startSession({ taskId: task.id, personaId: "scheduled-persona", budget: { maxSeconds: 33 }, defer: true });
    const run = (await db.select().from(agentSessions).where(eq(agentSessions.id, session.id)))[0];
    expect(run.toolsProfile).toBe("orchestrator");
    expect(run.budgetMaxTurns).toBe(11);
    expect(run.budgetMaxSeconds).toBe(33);
  });

  it("preserves paused state, clears nullable overrides, and accepts cadence changes", async () => {
    const schedule = await schedules.createSchedule({ name: "interval", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 60, model: "x", baseBranch: "feature", toolsProfile: "orchestrator", budgetMaxTurns: 3 }, clock("2026-01-01T00:00:00Z"));
    await schedules.pauseSchedule(schedule.id, clock("2026-01-01T00:01:00Z"));
    const updated = await schedules.updateSchedule(schedule.id, { kind: "cron", cronExpression: "0 * * * *", model: null, baseBranch: null, toolsProfile: null, budgetMaxTurns: null }, clock("2026-01-01T00:01:00Z"));
    expect(updated.enabled).toBe(false);
    expect(updated.kind).toBe("cron");
    expect(updated.intervalSeconds).toBeNull();
    expect(updated.model).toBeNull();
    expect(updated.baseBranch).toBeNull();
    expect(updated.toolsProfile).toBeNull();
    expect(updated.budgetMaxTurns).toBeNull();
  });

  it("resumes intervals strictly after now from the original cadence anchor", async () => {
    const schedule = await schedules.createSchedule({ name: "interval", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 3600, startAt: new Date("2026-01-01T00:00:00Z") }, clock("2026-01-01T00:00:00Z"));
    await schedules.pauseSchedule(schedule.id, clock("2026-01-01T00:05:00Z"));
    const resumed = await schedules.resumeSchedule(schedule.id, clock("2026-01-01T04:30:00Z"));
    expect(resumed.nextRunAt?.toISOString()).toBe("2026-01-01T05:00:00.000Z");
  });

  it("never re-arms a consumed once schedule through metadata edits or resume", async () => {
    const schedule = await schedules.createSchedule({ name: "once", prompt: "work", repoId: "R-default", kind: "once", runAt: new Date("2026-01-01T00:00:00Z") }, clock("2025-12-31T00:00:00Z"));
    await schedules.claimDueSchedules(clock("2026-01-01T00:01:00Z"));
    const updated = await schedules.updateSchedule(schedule.id, { name: "renamed" }, clock("2026-01-01T00:02:00Z"));
    const resumed = await schedules.resumeSchedule(schedule.id, clock("2026-01-01T00:03:00Z"));
    expect(updated.enabled).toBe(false); expect(updated.nextRunAt).toBeNull();
    expect(resumed.enabled).toBe(false); expect(resumed.nextRunAt).toBeNull();
    expect(await schedules.claimDueSchedules(clock("2026-01-02T00:00:00Z"))).toEqual([]);
  });

  it("soft-deletes schedules and rejects later run-now attempts", async () => {
    const schedule = await schedules.createSchedule({ name: "delete", prompt: "work", repoId: "R-default", kind: "interval", intervalSeconds: 60 }, clock("2026-01-01T00:00:00Z"));
    const deleted = await schedules.deleteSchedule(schedule.id, clock("2026-01-01T00:01:00Z"));
    expect(deleted.enabled).toBe(false);
    expect(await schedules.getSchedule(schedule.id)).toBeNull();
    await expect(schedules.runScheduleNow(schedule.id, clock("2026-01-01T00:02:00Z"))).rejects.toThrow(/not found/);
  });

  it("rejects malformed runtime input and invalid referenced overrides", async () => {
    expect(() => schedules.validateSchedule({ name: "bad", prompt: "x", repoId: "R-default", kind: "cron", cronExpression: "* * * * * *" })).toThrow(/five fields/);
    expect(() => schedules.validateSchedule({ name: "bad", prompt: "x", repoId: "R-default", kind: "interval", intervalSeconds: 1.5 })).toThrow();
    expect(() => schedules.validateSchedule({ name: "bad", prompt: "x", repoId: "R-default", kind: "once", runAt: new Date(NaN) })).toThrow();
    await expect(schedules.createSchedule({ name: "bad", prompt: "x", repoId: "R-default", kind: "interval", intervalSeconds: 1, toolsProfile: "unknown" })).rejects.toThrow(/Unknown tools profile/);
    await expect(schedules.createSchedule({ name: "bad", prompt: "x", repoId: "R-default", kind: "interval", intervalSeconds: 1, personaId: "unknown" })).rejects.toThrow(/Persona unknown/);
  });
});
