import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { firstOccurrenceAt, nextCronInstant } from "./schedule-time";
import { and, asc, desc, eq, inArray, isNull, lte, ne, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { agentEvents, agentSessions, runSchedules, scheduleOccurrences, tasks } from "@/db/schema";
import { scheduleInputSchema, schedulePatchSchema } from "./validators";
import { listProfiles } from "./profiles";
import * as repo from "./repo";
import { RepoError } from "./repo";
import { TERMINAL_STATUSES } from "./run-state";

export type ScheduleKind = "once" | "interval" | "cron";
export type OccurrenceStatus = "pending" | "launching" | "launched" | "skipped" | "failed";
// A crashed owner may be recovered after this lease. Normal launch never holds
// the transaction open: the token is the durable ownership fence.
const LAUNCH_LEASE_MS = 5 * 60 * 1000;

export interface ScheduleInput {
  name: string; prompt: string; repoId: string; baseBranch?: string | null;
  kind: ScheduleKind; runAt?: Date; startAt?: Date; intervalSeconds?: number; cronExpression?: string;
  timezone?: string; personaId?: string | null; model?: string | null; toolsProfile?: string | null;
  autoMerge?: boolean; budgetMaxTurns?: number | null; budgetMaxUsd?: number | null;
  budgetMaxSeconds?: number | null; userId?: number | null;
}
type SchedulePatch = Partial<Omit<ScheduleInput, "runAt" | "intervalSeconds" | "cronExpression">> & {
  runAt?: Date | null; intervalSeconds?: number | null; cronExpression?: string | null;
};
export interface ScheduleClock { now(): Date }
const systemClock: ScheduleClock = { now: () => new Date() };

function validationError(error: unknown): never {
  throw new RepoError(error instanceof Error ? error.message : "Invalid schedule input", 400);
}

/** Synchronous shape/cadence validation; reference checks live in validateScheduleReferences. */
export function validateSchedule(input: ScheduleInput): void {
  const parsed = scheduleInputSchema.safeParse(input);
  if (!parsed.success) validationError(parsed.error);
  if (input.kind === "once") {
    if (!input.runAt || input.intervalSeconds != null || input.cronExpression != null) throw new RepoError("Once schedules require only runAt", 400);
  } else if (input.kind === "interval") {
    if (!input.intervalSeconds || input.runAt || input.cronExpression) throw new RepoError("Interval schedules require a positive intervalSeconds", 400);
  } else if (input.kind === "cron") {
    if (!input.cronExpression || input.runAt || input.intervalSeconds != null) throw new RepoError("Cron schedules require only cronExpression", 400);
    if (input.cronExpression.trim().split(/\s+/).length !== 5) throw new RepoError("Cron expressions must have five fields", 400);
    try { CronExpressionParser.parse(input.cronExpression, { tz: input.timezone ?? "UTC" }); } catch { throw new RepoError("Invalid five-field cron expression", 400); }
  } else {
    throw new RepoError("Invalid schedule kind", 400);
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone ?? "UTC" }); } catch { throw new RepoError(`Invalid IANA timezone: ${input.timezone}`, 400); }
}

async function validateScheduleReferences(input: ScheduleInput): Promise<void> {
  if (!(await repo.getRepository(input.repoId))) throw new RepoError(`Repository ${input.repoId} not found`, 404);
  if (input.personaId && !(await repo.getPersona(input.personaId))) throw new RepoError(`Persona ${input.personaId} not found`, 404);
  if (input.toolsProfile) {
    const known = new Set(listProfiles());
    const unknown = input.toolsProfile.split(",").map((part) => part.trim()).filter((part) => !part || !known.has(part));
    if (unknown.length) throw new RepoError(`Unknown tools profile: ${unknown.join(", ")}`, 400);
  }
}

export function nextCadenceAt(schedule: Pick<typeof runSchedules.$inferSelect, "kind" | "intervalSeconds" | "cronExpression" | "timezone">, after: Date): Date {
  if (schedule.kind === "interval") return new Date(after.getTime() + (schedule.intervalSeconds ?? 0) * 1000);
  if (schedule.kind === "cron") return nextCronInstant(schedule.cronExpression!, schedule.timezone, after);
  throw new RepoError("One-time schedules do not recur", 400);
}

function latestCronAndNext(schedule: typeof runSchedules.$inferSelect, now: Date): { scheduledFor: Date; next: Date } {
  // Parser operations are bounded regardless of downtime; do not enumerate every
  // missed minute while holding the schedule-row claim lock.
  const options = { tz: schedule.timezone, currentDate: now };
  const next = CronExpressionParser.parse(schedule.cronExpression!, options).next().toDate();
  const candidate = CronExpressionParser.parse(schedule.cronExpression!, { ...options, currentDate: new Date(now.getTime() + 1) }).prev().toDate();
  return { scheduledFor: candidate > schedule.nextRunAt! ? candidate : schedule.nextRunAt!, next };
}

export async function createSchedule(input: ScheduleInput, clock = systemClock) {
  validateSchedule(input);
  await validateScheduleReferences(input);
  const now = clock.now();
  const nextRunAt = input.kind === "once" ? input.runAt! : input.kind === "interval" ? firstOccurrenceAt("interval", now, input.startAt, input.intervalSeconds) : nextCadenceAt({ kind: "cron", cronExpression: input.cronExpression!, timezone: input.timezone ?? "UTC", intervalSeconds: null }, now);
  return (await db.insert(runSchedules).values({
    name: input.name.trim(), prompt: input.prompt, repoId: input.repoId, baseBranch: input.baseBranch ?? null,
    kind: input.kind, runAt: input.kind === "once" ? input.runAt! : null,
    intervalSeconds: input.kind === "interval" ? input.intervalSeconds! : null,
    cronExpression: input.kind === "cron" ? input.cronExpression! : null, timezone: input.timezone ?? "UTC",
    nextRunAt, personaId: input.personaId ?? null, model: input.model ?? null, toolsProfile: input.toolsProfile ?? null,
    autoMerge: input.autoMerge ?? false, budgetMaxTurns: input.budgetMaxTurns ?? null, budgetMaxUsd: input.budgetMaxUsd ?? null,
    budgetMaxSeconds: input.budgetMaxSeconds ?? null, userId: input.userId ?? null, createdAt: now, updatedAt: now,
  }).returning())[0];
}

/** Atomically claim only the newest missed instant and advance cadence before slow launch work. */
export async function claimDueSchedules(clock = systemClock): Promise<number[]> {
  const now = clock.now();
  return db.transaction(async (tx) => {
    const due = await tx.select().from(runSchedules).where(and(eq(runSchedules.enabled, true), isNull(runSchedules.deletedAt), lte(runSchedules.nextRunAt, now))).orderBy(asc(runSchedules.nextRunAt)).for("update", { skipLocked: true });
    const occurrenceIds: number[] = [];
    for (const schedule of due) {
      let scheduledFor = schedule.nextRunAt!;
      if (schedule.kind === "interval") {
        const periodMs = schedule.intervalSeconds! * 1000;
        const elapsed = Math.max(0, Math.floor((now.getTime() - scheduledFor.getTime()) / periodMs));
        scheduledFor = new Date(scheduledFor.getTime() + elapsed * periodMs);
        const next = new Date(scheduledFor.getTime() + periodMs);
        await tx.update(runSchedules).set({ nextRunAt: next, lastScheduledAt: scheduledFor, updatedAt: now }).where(eq(runSchedules.id, schedule.id));
      } else if (schedule.kind === "cron") {
        const cadence = latestCronAndNext(schedule, now);
        scheduledFor = cadence.scheduledFor;
        await tx.update(runSchedules).set({ nextRunAt: cadence.next, lastScheduledAt: scheduledFor, updatedAt: now }).where(eq(runSchedules.id, schedule.id));
      } else {
        await tx.update(runSchedules).set({ enabled: false, nextRunAt: null, lastScheduledAt: scheduledFor, updatedAt: now }).where(eq(runSchedules.id, schedule.id));
      }
      const occurrence = (await tx.insert(scheduleOccurrences).values({ scheduleId: schedule.id, scheduledFor, status: "pending", createdAt: now, updatedAt: now }).onConflictDoNothing().returning())[0]
        ?? (await tx.select().from(scheduleOccurrences).where(and(eq(scheduleOccurrences.scheduleId, schedule.id), eq(scheduleOccurrences.scheduledFor, scheduledFor))))[0];
      if (occurrence && occurrence.status === "pending") occurrenceIds.push(occurrence.id);
    }
    return occurrenceIds;
  });
}

type LaunchClaim = { occurrence: typeof scheduleOccurrences.$inferSelect; schedule: typeof runSchedules.$inferSelect; task: typeof tasks.$inferSelect | null; run: typeof agentSessions.$inferSelect | null; token: string };

/** Reserve a single schedule-level launch; canonical start deliberately happens after this transaction. */
async function reserveLaunch(occurrenceId: number, now: Date): Promise<LaunchClaim | null> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const occurrence = (await tx.select().from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)).for("update"))[0];
    if (!occurrence || ["launched", "skipped", "failed"].includes(occurrence.status)) return null;
    // Lock the schedule row too: different occurrence rows from the same schedule
    // cannot both reserve a launch.
    const schedule = (await tx.select().from(runSchedules).where(eq(runSchedules.id, occurrence.scheduleId)).for("update"))[0];
    if (!schedule || schedule.deletedAt) {
      await tx.update(scheduleOccurrences).set({ status: "skipped", error: "Schedule deleted", updatedAt: now }).where(eq(scheduleOccurrences.id, occurrenceId));
      return null;
    }
    const [task] = await tx.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId));
    const [run] = await tx.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId));
    // Read durable links before overlap checks so recovery reuses work already
    // created for this occurrence. The lease fences finalization too: even a
    // task-linked run has an owner until its claim expires.
    const leaseLive = occurrence.status === "launching" && occurrence.launchClaimedAt && occurrence.launchClaimedAt.getTime() > now.getTime() - LAUNCH_LEASE_MS;
    if (leaseLive) return null;
    if (!run) {
      const [otherLaunching] = await tx.select({ id: scheduleOccurrences.id }).from(scheduleOccurrences)
        .where(and(eq(scheduleOccurrences.scheduleId, schedule.id), ne(scheduleOccurrences.id, occurrenceId), eq(scheduleOccurrences.status, "launching"))).limit(1);
      const [otherActive] = await tx.select({ id: scheduleOccurrences.id }).from(scheduleOccurrences)
        .innerJoin(agentSessions, eq(agentSessions.scheduleOccurrenceId, scheduleOccurrences.id))
        .where(and(eq(scheduleOccurrences.scheduleId, schedule.id), ne(scheduleOccurrences.id, occurrenceId), notInArray(agentSessions.status, TERMINAL_STATUSES))).limit(1);
      if (otherLaunching || otherActive) {
        await tx.update(scheduleOccurrences).set({ status: "skipped", error: "A prior occurrence still owns or has an active run", updatedAt: now }).where(eq(scheduleOccurrences.id, occurrenceId));
        return null;
      }
      // The task idempotency link does not transfer launch ownership. The
      // live-lease guard above protects the task-created/run-missing window
      // before these overlap checks can permit recovery.
    }
    const reserved = (await tx.update(scheduleOccurrences).set({ status: "launching", launchToken: token, launchClaimedAt: now, error: null, updatedAt: now }).where(eq(scheduleOccurrences.id, occurrenceId)).returning())[0];
    return { occurrence: reserved, schedule, task: task ?? null, run: run ?? null, token };
  });
}

/** Mirror the canonical worktree-start lifecycle for runs whose checkout is
 * materialized only in a detached worker. Re-read through the repository layer
 * so a recovered occurrence never regresses a task that has already reached a
 * later (or terminal) state. */
async function startScheduledTask(taskId: string): Promise<void> {
  const task = await repo.getTask(taskId);
  if (!task || (task.state !== "todo" && task.state !== "blocked")) return;
  try {
    await repo.transitionTask(taskId, {
      state: "in_progress",
      assignee: task.assignee ?? "claude-agent",
      note: "Started scheduled agent run.",
    });
  } catch (error) {
    // transitionTask serializes on the task row. A concurrent human/PR update
    // may have moved it beyond a startable state while this occurrence was
    // recovering; leave that newer state intact rather than failing or
    // overwriting it. Propagate genuine transition failures.
    const current = await repo.getTask(taskId);
    if (!current || (current.state !== "todo" && current.state !== "blocked")) return;
    throw error;
  }
}

async function recordScheduledRun(runId: number, occurrenceId: number, scheduleId: number, token: string, now: Date): Promise<void> {
  const payload = JSON.stringify({ occurrenceId, scheduleId });
  await db.transaction(async (tx) => {
    // The row lock serializes finalizers. Only the owner that still holds the
    // durable claim may transition launching -> launched; stale owners must not
    // revive a failure/skip or emit a duplicate event after recovery took over.
    const occurrence = (await tx.select({ status: scheduleOccurrences.status, launchToken: scheduleOccurrences.launchToken })
      .from(scheduleOccurrences).where(eq(scheduleOccurrences.id, occurrenceId)).for("update"))[0];
    if (!occurrence || occurrence.status !== "launching" || occurrence.launchToken !== token) return;
    const transitioned = await tx.update(scheduleOccurrences)
      .set({ status: "launched", error: null, launchToken: null, launchClaimedAt: null, updatedAt: now })
      .where(and(eq(scheduleOccurrences.id, occurrenceId), eq(scheduleOccurrences.status, "launching"), eq(scheduleOccurrences.launchToken, token)))
      .returning({ id: scheduleOccurrences.id });
    if (transitioned.length) {
      await tx.insert(agentEvents).values({ sessionId: runId, type: "scheduled_run", payload, createdAt: now });
    }
  });
}

export async function launchOccurrence(occurrenceId: number, clock = systemClock): Promise<void> {
  const now = clock.now();
  const claimed = await reserveLaunch(occurrenceId, now);
  if (!claimed) return;
  try {
    const schedule = claimed.schedule;
    let task = claimed.task;
    if (!task) {
      try {
        const created = await repo.createTask({ title: schedule.name, body: schedule.prompt, planId: null, repoId: schedule.repoId, scheduleOccurrenceId: occurrenceId });
        task = (await db.select().from(tasks).where(eq(tasks.id, created.id)))[0]!;
      } catch (error) {
        task = (await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrenceId)))[0];
        if (!task) throw error;
      }
    }
    // Detached workers materialize their own checkout, so they cannot use
    // runs.ts's server-side ensureWorktreeBranch() lifecycle transition.
    // Perform the same repository-validated transition before either a fresh
    // or recovered scheduled run is dispatched.
    await startScheduledTask(task.id);
    let run = claimed.run ?? (await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId)))[0];
    if (!run) {
      try {
        const agent = await import("./agent");
        const session = await agent.startSession({ taskId: task.id, model: schedule.model ?? undefined, baseBranch: schedule.baseBranch ?? undefined, userId: schedule.userId, personaId: schedule.personaId, toolsProfile: schedule.toolsProfile, autoMerge: schedule.autoMerge, scheduleOccurrenceId: occurrenceId, budget: { maxTurns: schedule.budgetMaxTurns ?? undefined, maxUsd: schedule.budgetMaxUsd ?? undefined, maxSeconds: schedule.budgetMaxSeconds ?? undefined } });
        run = (await db.select().from(agentSessions).where(eq(agentSessions.id, session.id)))[0]!;
      } catch (error) {
        run = (await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrenceId)))[0];
        if (!run) throw error;
      }
    }
    await recordScheduledRun(run.id, occurrenceId, schedule.id, claimed.token, clock.now());
  } catch (error) {
    // Do not overwrite a reservation that was safely recovered by another owner.
    await db.update(scheduleOccurrences).set({ status: "failed", error: error instanceof Error ? error.message : String(error), launchToken: null, launchClaimedAt: null, updatedAt: clock.now() }).where(and(eq(scheduleOccurrences.id, occurrenceId), eq(scheduleOccurrences.status, "launching"), eq(scheduleOccurrences.launchToken, claimed.token)));
  }
}

export async function listSchedules() { return db.select().from(runSchedules).where(isNull(runSchedules.deletedAt)).orderBy(asc(runSchedules.id)); }
export async function getSchedule(id: number) { return (await db.select().from(runSchedules).where(and(eq(runSchedules.id, id), isNull(runSchedules.deletedAt))))[0] ?? null; }

/** The operator-facing schedule projection. Keep the schedule row intact and
 * attach the latest occurrence's task/run/PR state so collection and detail
 * views do not need to reproduce scheduler joins. */
export async function getScheduleSurface(id: number) {
  const schedule = await getSchedule(id);
  if (!schedule) return null;
  const repository = await repo.getRepository(schedule.repoId);
  const occurrence = (await db.select().from(scheduleOccurrences)
    .where(eq(scheduleOccurrences.scheduleId, id))
    .orderBy(desc(scheduleOccurrences.scheduledFor), desc(scheduleOccurrences.id)).limit(1))[0] ?? null;
  if (!occurrence) return { ...schedule, repository, recentOccurrence: null, recentTask: null, recentRun: null, prUrl: null };
  const recentTask = (await db.select().from(tasks).where(eq(tasks.scheduleOccurrenceId, occurrence.id)).limit(1))[0] ?? null;
  const recentRun = (await db.select().from(agentSessions).where(eq(agentSessions.scheduleOccurrenceId, occurrence.id)).limit(1))[0] ?? null;
  return {
    ...schedule,
    repository,
    recentOccurrence: occurrence,
    recentTask,
    recentRun,
    prUrl: recentRun?.prUrl ?? recentTask?.prUrl ?? null,
  };
}

export async function listScheduleSurfaces() {
  const schedules = await listSchedules();
  const surfaces = await Promise.all(schedules.map((schedule) => getScheduleSurface(schedule.id)));
  return surfaces.filter((surface): surface is NonNullable<typeof surface> => surface !== null);
}
const supplied = <T extends object>(object: T, key: keyof T) => Object.prototype.hasOwnProperty.call(object, key);

export async function updateSchedule(id: number, patch: SchedulePatch, clock = systemClock) {
  const parsed = schedulePatchSchema.safeParse(patch);
  if (!parsed.success) validationError(parsed.error);
  const current = await getSchedule(id);
  if (!current) throw new RepoError(`Schedule ${id} not found`, 404);
  const kind = (patch.kind ?? current.kind) as ScheduleKind;
  const value = <K extends keyof SchedulePatch, V>(key: K, fallback: V) => supplied(patch, key) ? patch[key] as V : fallback;
  const next: ScheduleInput = {
    name: value("name", current.name), prompt: value("prompt", current.prompt), repoId: value("repoId", current.repoId),
    baseBranch: value("baseBranch", current.baseBranch), kind, timezone: value("timezone", current.timezone),
    personaId: value("personaId", current.personaId), model: value("model", current.model), toolsProfile: value("toolsProfile", current.toolsProfile),
    autoMerge: value("autoMerge", current.autoMerge), budgetMaxTurns: value("budgetMaxTurns", current.budgetMaxTurns), budgetMaxUsd: value("budgetMaxUsd", current.budgetMaxUsd), budgetMaxSeconds: value("budgetMaxSeconds", current.budgetMaxSeconds), userId: value("userId", current.userId),
    runAt: kind === "once" ? value("runAt", current.kind === "once" ? current.runAt ?? undefined : undefined) ?? undefined : undefined,
    intervalSeconds: kind === "interval" ? value("intervalSeconds", current.kind === "interval" ? current.intervalSeconds ?? undefined : undefined) ?? undefined : undefined,
    cronExpression: kind === "cron" ? value("cronExpression", current.kind === "cron" ? current.cronExpression ?? undefined : undefined) ?? undefined : undefined,
  };
  validateSchedule(next);
  await validateScheduleReferences(next);
  const now = clock.now();
  const completedOnce = current.kind === "once" && current.lastScheduledAt !== null;
  const enabled = current.enabled && !completedOnce;
  let nextRunAt: Date | null;
  if (completedOnce) nextRunAt = null;
  else if (kind === "once") nextRunAt = next.runAt!;
  else if (kind === "interval") nextRunAt = patch.startAt ?? (current.kind === "interval" ? current.nextRunAt ?? now : now);
  else nextRunAt = nextCadenceAt({ kind: "cron", cronExpression: next.cronExpression!, timezone: next.timezone ?? "UTC", intervalSeconds: null }, now);
  return (await db.update(runSchedules).set({
    name: next.name, prompt: next.prompt, repoId: next.repoId, baseBranch: next.baseBranch ?? null, kind,
    runAt: kind === "once" ? next.runAt! : null, intervalSeconds: kind === "interval" ? next.intervalSeconds! : null, cronExpression: kind === "cron" ? next.cronExpression! : null,
    timezone: next.timezone ?? "UTC", personaId: next.personaId ?? null, model: next.model ?? null, toolsProfile: next.toolsProfile ?? null, autoMerge: next.autoMerge ?? false,
    budgetMaxTurns: next.budgetMaxTurns ?? null, budgetMaxUsd: next.budgetMaxUsd ?? null, budgetMaxSeconds: next.budgetMaxSeconds ?? null, userId: next.userId ?? null,
    enabled, nextRunAt, updatedAt: now,
  }).where(eq(runSchedules.id, id)).returning())[0];
}
export async function pauseSchedule(id: number, clock = systemClock) {
  const row = (await db.update(runSchedules).set({ enabled: false, updatedAt: clock.now() }).where(and(eq(runSchedules.id, id), isNull(runSchedules.deletedAt))).returning())[0];
  if (!row) throw new RepoError(`Schedule ${id} not found`, 404); return row;
}
export async function resumeSchedule(id: number, clock = systemClock) {
  const schedule = await getSchedule(id); if (!schedule) throw new RepoError(`Schedule ${id} not found`, 404);
  const now = clock.now();
  if (schedule.kind === "once" && (schedule.lastScheduledAt || schedule.runAt! <= now)) {
    return (await db.update(runSchedules).set({ enabled: false, nextRunAt: null, updatedAt: now }).where(eq(runSchedules.id, id)).returning())[0];
  }
  let nextRunAt: Date;
  if (schedule.kind === "interval") {
    const anchor = schedule.lastScheduledAt ?? schedule.nextRunAt!;
    const periodMs = schedule.intervalSeconds! * 1000;
    const steps = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / periodMs) + 1);
    nextRunAt = new Date(anchor.getTime() + steps * periodMs);
  } else if (schedule.kind === "cron") nextRunAt = nextCadenceAt(schedule, now);
  else nextRunAt = schedule.runAt!;
  return (await db.update(runSchedules).set({ enabled: true, nextRunAt, updatedAt: now }).where(eq(runSchedules.id, id)).returning())[0];
}
export async function deleteSchedule(id: number, clock = systemClock) {
  const now = clock.now();
  const row = (await db.update(runSchedules).set({ enabled: false, deletedAt: now, updatedAt: now }).where(and(eq(runSchedules.id, id), isNull(runSchedules.deletedAt))).returning())[0];
  if (!row) throw new RepoError(`Schedule ${id} not found`, 404); return row;
}
export async function runScheduleNow(id: number, clock = systemClock) {
  const schedule = await getSchedule(id); if (!schedule) throw new RepoError(`Schedule ${id} not found`, 404);
  const now = clock.now();
  const occurrence = (await db.insert(scheduleOccurrences).values({ scheduleId: id, scheduledFor: now, status: "pending", createdAt: now, updatedAt: now }).onConflictDoNothing().returning())[0]
    ?? (await db.select().from(scheduleOccurrences).where(and(eq(scheduleOccurrences.scheduleId, id), eq(scheduleOccurrences.scheduledFor, now))))[0];
  await launchOccurrence(occurrence.id, clock); return occurrence.id;
}
export async function fireDueSchedules(clock = systemClock): Promise<void> { for (const id of await claimDueSchedules(clock)) await launchOccurrence(id, clock); }
export async function reconcileScheduleOccurrences(clock = systemClock): Promise<void> {
  const rows = await db.select({ id: scheduleOccurrences.id }).from(scheduleOccurrences).where(inArray(scheduleOccurrences.status, ["pending", "launching"]));
  for (const row of rows) await launchOccurrence(row.id, clock);
}
