import { and, asc, count, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  acceptanceCriteria,
  agentSessions,
  planRepositories,
  plans,
  repositories,
  taskDependencies,
  taskNotes,
  tasks,
  type Plan as PlanRow,
  type Repository as RepositoryDbRow,
  type Task as TaskRow,
} from "@/db/schema";
import {
  TASK_TRANSITIONS,
  PLAN_TRANSITIONS,
  type PlanFull,
  type PlanProgress,
  type PlanState,
  type RepositoryRow,
  type TaskFull,
  type TaskState,
} from "./types";

// ──────────────────────────────────────────────────────────
// IDs & slugs
// ──────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function planIdFromTitle(title: string, date: string): string {
  return `P-${date}-${slugify(title)}`;
}

function nextTaskId(date: string): string {
  const datePart = date.replace(/-/g, "");
  const prefix = `T-${datePart}-`;
  const rows = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(like(tasks.id, `${prefix}%`))
    .all();
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.id.slice(prefix.length), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// ──────────────────────────────────────────────────────────
// Hydration helpers
// ──────────────────────────────────────────────────────────

function hydratePlan(row: PlanRow, repos: RepositoryRow[]): PlanFull {
  return {
    id: row.id,
    title: row.title,
    state: row.state as PlanState,
    owner: row.owner,
    body: row.body,
    tags: safeJsonArray(row.tags),
    repos,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function reposForPlan(planId: string): RepositoryRow[] {
  return db
    .select({
      id: repositories.id,
      name: repositories.name,
      remote: repositories.remote,
      localPath: repositories.localPath,
      defaultBranch: repositories.defaultBranch,
      description: repositories.description,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
    })
    .from(planRepositories)
    .innerJoin(repositories, eq(repositories.id, planRepositories.repoId))
    .where(eq(planRepositories.planId, planId))
    .orderBy(asc(planRepositories.position), asc(repositories.id))
    .all();
}

function reposForPlans(planIds: string[]): Map<string, RepositoryRow[]> {
  const out = new Map<string, RepositoryRow[]>();
  for (const id of planIds) out.set(id, []);
  if (planIds.length === 0) return out;
  const rows = db
    .select({
      planId: planRepositories.planId,
      position: planRepositories.position,
      id: repositories.id,
      name: repositories.name,
      remote: repositories.remote,
      localPath: repositories.localPath,
      defaultBranch: repositories.defaultBranch,
      description: repositories.description,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
    })
    .from(planRepositories)
    .innerJoin(repositories, eq(repositories.id, planRepositories.repoId))
    .where(inArray(planRepositories.planId, planIds))
    .orderBy(asc(planRepositories.position), asc(repositories.id))
    .all();
  for (const r of rows) {
    const list = out.get(r.planId);
    if (!list) continue;
    const { planId: _planId, position: _position, ...repo } = r;
    void _planId;
    void _position;
    list.push(repo);
  }
  return out;
}

function hydrateRepository(row: RepositoryDbRow): RepositoryRow {
  return {
    id: row.id,
    name: row.name,
    remote: row.remote,
    localPath: row.localPath,
    defaultBranch: row.defaultBranch,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function hydrateTask(
  row: TaskRow,
  deps: string[],
  notes: TaskFull["notes"],
  criteria: TaskFull["criteria"]
): TaskFull {
  return {
    id: row.id,
    title: row.title,
    state: row.state as TaskState,
    planId: row.planId,
    assignee: row.assignee,
    body: row.body,
    estimate: row.estimate,
    tags: safeJsonArray(row.tags),
    repoId: row.repoId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dependencies: deps,
    notes,
    criteria,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────
// Plan queries
// ──────────────────────────────────────────────────────────

export function listPlans(): PlanFull[] {
  const rows = db.select().from(plans).orderBy(asc(plans.id)).all();
  if (rows.length === 0) return [];
  const byPlan = reposForPlans(rows.map((r) => r.id));
  return rows.map((r) => hydratePlan(r, byPlan.get(r.id) ?? []));
}

export function getPlan(id: string): PlanFull | null {
  const row = db.select().from(plans).where(eq(plans.id, id)).get();
  return row ? hydratePlan(row, reposForPlan(id)) : null;
}

export function planProgress(planId: string): PlanProgress {
  const all = db
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.planId, planId))
    .all();
  const active = all.filter((t) => t.state !== "cancelled");
  const total = active.length;
  const done = active.filter((t) => t.state === "done").length;
  const open = active.filter((t) => t.state !== "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct, open };
}

// Batched planProgress for N plans in a single GROUP BY query. Returns
// a Map keyed by plan id; plans with no tasks are still present with
// zeroed counts so callers can index unconditionally.
export function planProgressBatch(planIds: string[]): Map<string, PlanProgress> {
  const out = new Map<string, PlanProgress>();
  for (const id of planIds) out.set(id, { total: 0, done: 0, pct: 0, open: 0 });
  if (planIds.length === 0) return out;
  const rows = db
    .select({ planId: tasks.planId, state: tasks.state, n: count() })
    .from(tasks)
    .where(inArray(tasks.planId, planIds))
    .groupBy(tasks.planId, tasks.state)
    .all();
  // First pass: accumulate totals and done.
  for (const r of rows) {
    if (r.state === "cancelled") continue;
    const p = out.get(r.planId)!;
    p.total += Number(r.n);
    if (r.state === "done") p.done += Number(r.n);
  }
  for (const p of out.values()) {
    p.open = p.total - p.done;
    p.pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Task queries
// ──────────────────────────────────────────────────────────

export interface TaskFilters {
  state?: TaskState;
  planId?: string;
  assignee?: string;
}

export function listTasks(filters: TaskFilters = {}): TaskFull[] {
  const wheres = [];
  if (filters.state) wheres.push(eq(tasks.state, filters.state));
  if (filters.planId) wheres.push(eq(tasks.planId, filters.planId));
  if (filters.assignee) wheres.push(eq(tasks.assignee, filters.assignee));
  const where = wheres.length ? and(...wheres) : undefined;
  const rows = where
    ? db.select().from(tasks).where(where).orderBy(asc(tasks.id)).all()
    : db.select().from(tasks).orderBy(asc(tasks.id)).all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const depRows = db
    .select()
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, ids))
    .all();
  const noteRows = db
    .select()
    .from(taskNotes)
    .where(inArray(taskNotes.taskId, ids))
    .orderBy(asc(taskNotes.createdAt))
    .all();
  const critRows = db
    .select()
    .from(acceptanceCriteria)
    .where(inArray(acceptanceCriteria.taskId, ids))
    .orderBy(asc(acceptanceCriteria.position))
    .all();
  const depsByTask = groupBy(depRows, (r) => r.taskId);
  const notesByTask = groupBy(noteRows, (r) => r.taskId);
  const critsByTask = groupBy(critRows, (r) => r.taskId);
  return rows.map((r) =>
    hydrateTask(
      r,
      (depsByTask.get(r.id) ?? []).map((d) => d.dependsOnId),
      (notesByTask.get(r.id) ?? []).map((n) => ({
        id: n.id,
        author: n.author,
        body: n.body,
        createdAt: n.createdAt,
      })),
      (critsByTask.get(r.id) ?? []).map((c) => ({
        id: c.id,
        text: c.text,
        done: c.done,
        position: c.position,
      }))
    )
  );
}

export function getTask(id: string): TaskFull | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) return null;
  const deps = db
    .select({ dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, id))
    .all()
    .map((r) => r.dependsOnId);
  const notes = db
    .select()
    .from(taskNotes)
    .where(eq(taskNotes.taskId, id))
    .orderBy(asc(taskNotes.createdAt))
    .all()
    .map((n) => ({ id: n.id, author: n.author, body: n.body, createdAt: n.createdAt }));
  const criteria = db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, id))
    .orderBy(asc(acceptanceCriteria.position))
    .all()
    .map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position }));
  return hydrateTask(row, deps, notes, criteria);
}

export function taskCountsByState(): Record<TaskState, number> {
  const rows = db
    .select({ state: tasks.state, n: count() })
    .from(tasks)
    .groupBy(tasks.state)
    .all();
  const out: Record<TaskState, number> = {
    todo: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
  };
  for (const r of rows) out[r.state as TaskState] = Number(r.n);
  return out;
}

// ──────────────────────────────────────────────────────────
// Mutations: plans
// ──────────────────────────────────────────────────────────

export interface CreatePlanInput {
  id?: string;
  title: string;
  state?: PlanState;
  owner?: string;
  body?: string;
  tags?: string[];
  date?: string;
  /** Repositories this plan spans. If omitted, defaults to [defaultRepo()]. */
  repoIds?: string[];
}

export function createPlan(input: CreatePlanInput): PlanFull {
  const date = input.date ?? today();
  const id = input.id ?? planIdFromTitle(input.title, date);
  if (db.select().from(plans).where(eq(plans.id, id)).get()) {
    throw new RepoError(`Plan ${id} already exists`, 409);
  }
  const explicitRepos = input.repoIds;
  const repoIds = explicitRepos
    ? Array.from(new Set(explicitRepos.filter((r): r is string => Boolean(r))))
    : (() => {
        const fallback = defaultRepoId();
        return fallback ? [fallback] : [];
      })();
  // Validate each before any insert so the plan isn't created half-attached.
  for (const rid of repoIds) {
    if (!getRepository(rid)) throw new RepoError(`Repository ${rid} not found`, 404);
  }
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(plans)
      .values({
        id,
        title: input.title,
        state: input.state ?? "draft",
        owner: input.owner ?? null,
        body: input.body ?? "",
        tags: JSON.stringify(input.tags ?? []),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (repoIds.length > 0) {
      tx.insert(planRepositories)
        .values(repoIds.map((r, i) => ({ planId: id, repoId: r, position: i })))
        .run();
    }
  });
  return getPlan(id)!;
}

export interface UpdatePlanInput {
  title?: string;
  state?: PlanState;
  owner?: string | null;
  body?: string;
  tags?: string[];
  /** Replace the plan's full repository set. Pass [] to unattach all. */
  repoIds?: string[];
}

export function updatePlan(id: string, patch: UpdatePlanInput): PlanFull {
  const existing = getPlan(id);
  if (!existing) throw new RepoError(`Plan ${id} not found`, 404);
  if (patch.state && patch.state !== existing.state) {
    const allowed = PLAN_TRANSITIONS[existing.state];
    if (!allowed.includes(patch.state)) {
      throw new RepoError(
        `Cannot transition plan ${existing.state} → ${patch.state}`,
        400
      );
    }
  }
  if (patch.repoIds) {
    for (const rid of patch.repoIds) {
      if (!getRepository(rid)) throw new RepoError(`Repository ${rid} not found`, 404);
    }
  }
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.state !== undefined) values.state = patch.state;
  if (patch.owner !== undefined) values.owner = patch.owner;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.tags !== undefined) values.tags = JSON.stringify(patch.tags);
  db.transaction((tx) => {
    tx.update(plans).set(values).where(eq(plans.id, id)).run();
    if (patch.repoIds !== undefined) {
      tx.delete(planRepositories).where(eq(planRepositories.planId, id)).run();
      const unique = Array.from(new Set(patch.repoIds));
      if (unique.length > 0) {
        tx.insert(planRepositories)
          .values(unique.map((r, i) => ({ planId: id, repoId: r, position: i })))
          .run();
      }
    }
  });
  return getPlan(id)!;
}

// Granular helpers — preferred over `updatePlan({ repoIds })` for adding /
// removing a single repo from a plan because they don't disturb position
// ordering of the unaffected repos.
export function addPlanRepository(planId: string, repoId: string): PlanFull {
  const plan = getPlan(planId);
  if (!plan) throw new RepoError(`Plan ${planId} not found`, 404);
  if (!getRepository(repoId)) throw new RepoError(`Repository ${repoId} not found`, 404);
  if (plan.repos.some((r) => r.id === repoId)) return plan;
  const nextPosition = plan.repos.length;
  db.insert(planRepositories)
    .values({ planId, repoId, position: nextPosition })
    .run();
  db.update(plans).set({ updatedAt: new Date() }).where(eq(plans.id, planId)).run();
  return getPlan(planId)!;
}

export function removePlanRepository(planId: string, repoId: string): PlanFull {
  const plan = getPlan(planId);
  if (!plan) throw new RepoError(`Plan ${planId} not found`, 404);
  // Clear repoId on any task pinned to the repo being removed so we don't
  // leave dangling references that the resolver can't satisfy.
  db.transaction((tx) => {
    tx.delete(planRepositories)
      .where(
        and(eq(planRepositories.planId, planId), eq(planRepositories.repoId, repoId))
      )
      .run();
    tx.update(tasks)
      .set({ repoId: null, updatedAt: new Date() })
      .where(and(eq(tasks.planId, planId), eq(tasks.repoId, repoId)))
      .run();
    tx.update(plans).set({ updatedAt: new Date() }).where(eq(plans.id, planId)).run();
  });
  return getPlan(planId)!;
}

export function deletePlan(id: string) {
  db.delete(plans).where(eq(plans.id, id)).run();
}

// ──────────────────────────────────────────────────────────
// Mutations: tasks
// ──────────────────────────────────────────────────────────

export interface CreateTaskInput {
  id?: string;
  planId: string;
  title: string;
  assignee?: string | null;
  body?: string;
  estimate?: string | null;
  tags?: string[];
  dependencies?: string[];
  criteria?: string[];
  date?: string;
  /**
   * Repository this task acts on. Must be one of the plan's repos.
   * If omitted: inherits the plan's only repo when there's exactly one,
   * otherwise required.
   */
  repoId?: string | null;
}

export function createTask(input: CreateTaskInput): TaskFull {
  const plan = getPlan(input.planId);
  if (!plan) {
    throw new RepoError(`Plan ${input.planId} not found`, 404);
  }
  const date = input.date ?? today();
  const id = input.id ?? nextTaskId(date);
  if (db.select().from(tasks).where(eq(tasks.id, id)).get()) {
    throw new RepoError(`Task ${id} already exists`, 409);
  }

  // Resolve the task's repo: explicit → must be one of the plan's repos.
  // Implicit → only allowed if the plan has exactly one repo.
  let resolvedRepoId: string | null = null;
  if (input.repoId !== undefined && input.repoId !== null) {
    const planRepoIds = plan.repos.map((r) => r.id);
    if (!planRepoIds.includes(input.repoId)) {
      throw new RepoError(
        `Repository ${input.repoId} is not attached to plan ${plan.id}. Attach it first or pick from: ${planRepoIds.join(", ") || "(none)"}`,
        400
      );
    }
    resolvedRepoId = input.repoId;
  } else if (plan.repos.length === 1) {
    resolvedRepoId = plan.repos[0].id;
  } else if (plan.repos.length > 1) {
    throw new RepoError(
      `Plan ${plan.id} has ${plan.repos.length} repositories; specify which one this task targets via repo_id`,
      400
    );
  }
  // plan.repos.length === 0 → resolvedRepoId stays null; the agent will
  // refuse to start a session, surfacing a clear escalation.

  const deps = input.dependencies ?? [];
  if (deps.length > 0) {
    const existing = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, deps))
      .all();
    const found = new Set(existing.map((r) => r.id));
    const missing = deps.filter((d) => !found.has(d));
    if (missing.length > 0) {
      throw new RepoError(`Dependencies not found: ${missing.join(", ")}`, 400);
    }
  }
  const now = new Date();
  db.transaction((tx) => {
    tx.insert(tasks)
      .values({
        id,
        title: input.title,
        state: "todo",
        planId: input.planId,
        assignee: input.assignee ?? null,
        body: input.body ?? "",
        estimate: input.estimate ?? null,
        tags: JSON.stringify(input.tags ?? []),
        repoId: resolvedRepoId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (deps.length > 0) {
      tx.insert(taskDependencies)
        .values(deps.map((d) => ({ taskId: id, dependsOnId: d })))
        .run();
    }
    if (input.criteria?.length) {
      tx.insert(acceptanceCriteria)
        .values(
          input.criteria.map((text, i) => ({
            taskId: id,
            text,
            done: false,
            position: i,
          }))
        )
        .run();
    }
  });
  return getTask(id)!;
}

export function updateTask(
  id: string,
  patch: Partial<{
    title: string;
    assignee: string | null;
    body: string;
    estimate: string | null;
    tags: string[];
    dependencies: string[];
    repoId: string | null;
  }>
): TaskFull {
  const existing = getTask(id);
  if (!existing) throw new RepoError(`Task ${id} not found`, 404);
  if (patch.repoId !== undefined && patch.repoId !== null) {
    const plan = getPlan(existing.planId);
    const planRepoIds = plan?.repos.map((r) => r.id) ?? [];
    if (!planRepoIds.includes(patch.repoId)) {
      throw new RepoError(
        `Repository ${patch.repoId} is not attached to plan ${existing.planId}. Attach it first or pick from: ${planRepoIds.join(", ") || "(none)"}`,
        400
      );
    }
  }
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.assignee !== undefined) values.assignee = patch.assignee;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.estimate !== undefined) values.estimate = patch.estimate;
  if (patch.tags !== undefined) values.tags = JSON.stringify(patch.tags);
  if (patch.repoId !== undefined) values.repoId = patch.repoId;
  db.transaction((tx) => {
    tx.update(tasks).set(values).where(eq(tasks.id, id)).run();
    if (patch.dependencies !== undefined) {
      tx.delete(taskDependencies).where(eq(taskDependencies.taskId, id)).run();
      if (patch.dependencies.length > 0) {
        tx.insert(taskDependencies)
          .values(patch.dependencies.map((d) => ({ taskId: id, dependsOnId: d })))
          .run();
      }
    }
  });
  return getTask(id)!;
}

export interface TransitionInput {
  state: TaskState;
  assignee?: string;
  note?: string;
}

export function transitionTask(id: string, input: TransitionInput): TaskFull {
  const existing = getTask(id);
  if (!existing) throw new RepoError(`Task ${id} not found`, 404);
  const prev = existing.state;
  if (input.state !== prev) {
    const allowed = TASK_TRANSITIONS[prev];
    if (!allowed.includes(input.state)) {
      throw new RepoError(
        `Cannot transition ${prev} → ${input.state}. Allowed: ${allowed.join(", ") || "(terminal)"}`,
        400
      );
    }
  }
  let assignee = input.assignee ?? existing.assignee ?? undefined;
  if (input.state === "in_progress" && !assignee) {
    throw new RepoError("Going to in_progress requires an assignee", 400);
  }
  if (input.state === "done") {
    const openCriteria = existing.criteria.filter((c) => !c.done).length;
    if (openCriteria > 0) {
      throw new RepoError(
        `Cannot mark done: ${openCriteria} acceptance criteria still open`,
        400
      );
    }
  }
  const now = new Date();
  db.transaction((tx) => {
    tx.update(tasks)
      .set({ state: input.state, assignee: assignee ?? null, updatedAt: now })
      .where(eq(tasks.id, id))
      .run();
    if (input.note || input.state !== prev) {
      const body = input.note ?? `→ ${input.state}`;
      tx.insert(taskNotes)
        .values({ taskId: id, author: assignee ?? "system", body, createdAt: now })
        .run();
    }
  });
  return getTask(id)!;
}

export function deleteTask(id: string) {
  db.delete(tasks).where(eq(tasks.id, id)).run();
}

// ──────────────────────────────────────────────────────────
// Notes
// ──────────────────────────────────────────────────────────

export function addNote(taskId: string, author: string, body: string) {
  if (!getTask(taskId)) throw new RepoError(`Task ${taskId} not found`, 404);
  db.insert(taskNotes)
    .values({ taskId, author, body, createdAt: new Date() })
    .run();
  db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId)).run();
}

// ──────────────────────────────────────────────────────────
// Acceptance criteria
// ──────────────────────────────────────────────────────────

export function addCriterion(taskId: string, text: string) {
  if (!getTask(taskId)) throw new RepoError(`Task ${taskId} not found`, 404);
  const lastPos = db
    .select({ p: sql<number>`COALESCE(MAX(${acceptanceCriteria.position}), -1)` })
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, taskId))
    .get();
  const pos = (lastPos?.p ?? -1) + 1;
  db.insert(acceptanceCriteria)
    .values({ taskId, text, done: false, position: pos })
    .run();
  db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId)).run();
}

export function updateCriterion(criterionId: number, patch: { done?: boolean; text?: string }) {
  const row = db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.id, criterionId))
    .get();
  if (!row) throw new RepoError(`Criterion ${criterionId} not found`, 404);
  const values: Record<string, unknown> = {};
  if (patch.done !== undefined) values.done = patch.done;
  if (patch.text !== undefined) values.text = patch.text;
  db.update(acceptanceCriteria).set(values).where(eq(acceptanceCriteria.id, criterionId)).run();
  db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId)).run();
}

export function deleteCriterion(criterionId: number) {
  const row = db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.id, criterionId))
    .get();
  if (!row) return;
  db.delete(acceptanceCriteria).where(eq(acceptanceCriteria.id, criterionId)).run();
  db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId)).run();
}

// ──────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────

export class RepoError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "RepoError";
  }
}

// ──────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  }
  return m;
}

// ──────────────────────────────────────────────────────────
// Repositories
// ──────────────────────────────────────────────────────────

export const DEFAULT_REPO_ID = "R-default";

export function repoIdFromName(name: string): string {
  return `R-${slugify(name)}`;
}

export function listRepositories(): RepositoryRow[] {
  return db
    .select()
    .from(repositories)
    .orderBy(asc(repositories.id))
    .all()
    .map(hydrateRepository);
}

export function getRepository(id: string): RepositoryRow | null {
  const row = db.select().from(repositories).where(eq(repositories.id, id)).get();
  return row ? hydrateRepository(row) : null;
}

export interface CreateRepositoryInput {
  id?: string;
  name: string;
  remote?: string | null;
  localPath?: string | null;
  defaultBranch?: string;
  description?: string;
}

export function createRepository(input: CreateRepositoryInput): RepositoryRow {
  if (!input.name.trim()) throw new RepoError("Repository name is required", 400);
  const id = input.id?.trim() || repoIdFromName(input.name);
  if (!id) throw new RepoError("Repository id could not be derived", 400);
  if (db.select().from(repositories).where(eq(repositories.id, id)).get()) {
    throw new RepoError(`Repository ${id} already exists`, 409);
  }
  const now = new Date();
  db.insert(repositories)
    .values({
      id,
      name: input.name.trim(),
      remote: input.remote?.trim() || null,
      localPath: input.localPath?.trim() || null,
      defaultBranch: (input.defaultBranch ?? "main").trim() || "main",
      description: input.description ?? "",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getRepository(id)!;
}

export interface UpdateRepositoryInput {
  name?: string;
  remote?: string | null;
  localPath?: string | null;
  defaultBranch?: string;
  description?: string;
}

export function updateRepository(id: string, patch: UpdateRepositoryInput): RepositoryRow {
  const existing = getRepository(id);
  if (!existing) throw new RepoError(`Repository ${id} not found`, 404);
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const v = patch.name.trim();
    if (!v) throw new RepoError("Repository name cannot be empty", 400);
    values.name = v;
  }
  if (patch.remote !== undefined) {
    values.remote = patch.remote === null ? null : patch.remote.trim() || null;
  }
  if (patch.localPath !== undefined) {
    values.localPath = patch.localPath === null ? null : patch.localPath.trim() || null;
  }
  if (patch.defaultBranch !== undefined) {
    const v = patch.defaultBranch.trim() || "main";
    values.defaultBranch = v;
  }
  if (patch.description !== undefined) values.description = patch.description;
  db.update(repositories).set(values).where(eq(repositories.id, id)).run();
  return getRepository(id)!;
}

export function deleteRepository(id: string) {
  const existing = getRepository(id);
  if (!existing) return;
  // Block deletion if anything still references this repo — orphaning is
  // worse than the friction of an explicit reassignment.
  const planRefs = db
    .select({ planId: planRepositories.planId })
    .from(planRepositories)
    .where(eq(planRepositories.repoId, id))
    .all();
  // Since 0009, chats are folded into agent_runs. A chat-derived run is one
  // with legacy_chat_id IS NOT NULL; newly-created chat runs (post-0009)
  // also fit the same shape with goal='<chat>'. Both block deletion the
  // same way agent task runs do via the agentSessions FK.
  const runRefs = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.repoId, id))
    .all();
  if (planRefs.length > 0 || runRefs.length > 0) {
    throw new RepoError(
      `Cannot delete ${id}: ${planRefs.length} plan(s) and ${runRefs.length} run(s) still reference it. Reassign them first.`,
      409
    );
  }
  db.delete(repositories).where(eq(repositories.id, id)).run();
}

// Resolution helpers — single source of truth for "which repo does this run
// in?". Used by lib/agent.ts (task.repoId pinned at creation) and lib/chat.ts
// (chat.repoId). If a task has no repoId, the agent should escalate rather
// than guess — see the comment on createTask for the resolution rule.
export function resolveRepoForTask(taskId: string): RepositoryRow | null {
  const task = getTask(taskId);
  if (!task?.repoId) return null;
  return getRepository(task.repoId);
}

export function defaultRepoId(): string | null {
  // Default repo for newly-created plans/chats: prefer R-default if it's
  // configured (has a local_path), otherwise the first repository with a
  // local_path, otherwise null.
  const seeded = getRepository(DEFAULT_REPO_ID);
  if (seeded?.localPath) return seeded.id;
  const first = listRepositories().find((r) => r.localPath) ?? listRepositories()[0];
  return first?.id ?? null;
}

export function defaultRepo(): RepositoryRow | null {
  const id = defaultRepoId();
  return id ? getRepository(id) : null;
}
