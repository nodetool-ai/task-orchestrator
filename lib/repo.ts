import { and, asc, count, desc, eq, inArray, isNotNull, like, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  acceptanceCriteria,
  agentSessions,
  attachments,
  channelIdentities,
  memories,
  personaMemories,
  personas as personasTable,
  planRepositories,
  plans,
  repositories,
  taskDependencies,
  taskNotes,
  tasks,
  type Attachment as AttachmentRow,
  type ChannelIdentity,
  type Memory,
  type Persona,
  type Plan as PlanRow,
  type Repository as RepositoryDbRow,
  type Task as TaskRow,
} from "@/db/schema";
import { canonicalizePrUrl } from "./github-webhook";
import {
  TASK_TRANSITIONS,
  PLAN_TRANSITIONS,
  PLANNING_STAGE_TRANSITIONS,
  type AttachmentKind,
  type AttachmentMeta,
  type PlanFull,
  type PlanProgress,
  type PlanState,
  type PlanningStage,
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

// Deterministic base36 token derived from a string. Non-empty for any input
// (worst case "0"), and always [a-z0-9]. Used as a slug fallback so distinct
// titles map to distinct tokens.
function base36Token(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function planIdFromTitle(title: string, date: string): string {
  // An all-non-ASCII title (CJK/Cyrillic/emoji) slugifies to '' → a bare
  // `P-<date>-` that violates idPlanRe and collides across distinct titles.
  // Fall back to a deterministic base36 token of the title so distinct titles
  // yield distinct, valid ids (and the same title stays stable → 409 on dup).
  const slug = slugify(title) || `t${base36Token(title)}`;
  return `P-${date}-${slug}`;
}

/**
 * True for a Postgres unique-violation error (SQLSTATE 23505) — postgres.js
 * surfaces this as an error object with a `code` property; drizzle may wrap it
 * with the original as `cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

async function nextTaskId(date: string): Promise<string> {
  const datePart = date.replace(/-/g, "");
  const prefix = `T-${datePart}-`;
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(like(tasks.id, `${prefix}%`));
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

function hydratePlan(
  row: PlanRow,
  repos: RepositoryRow[],
  attachmentMetas: AttachmentMeta[]
): PlanFull {
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
    attachments: attachmentMetas,
  };
}

async function reposForPlan(planId: string): Promise<RepositoryRow[]> {
  return await db
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
    .orderBy(asc(planRepositories.position), asc(repositories.id));
}

async function reposForPlans(planIds: string[]): Promise<Map<string, RepositoryRow[]>> {
  const out = new Map<string, RepositoryRow[]>();
  for (const id of planIds) out.set(id, []);
  if (planIds.length === 0) return out;
  const rows = await db
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
    .orderBy(asc(planRepositories.position), asc(repositories.id));
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
  criteria: TaskFull["criteria"],
  attachmentMetas: AttachmentMeta[],
  // Latest run's PR, inferred from agent_sessions — only used as a fallback
  // when the task's own (explicit, tool-set) pr_url column is unset.
  inferredPrUrl: string | null = null
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
    prUrl: row.prUrl ?? inferredPrUrl ?? null,
    branch: row.branch ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dependencies: deps,
    notes,
    criteria,
    attachments: attachmentMetas,
  };
}

/** Map of taskId → latest (highest run id) PR url, for a set of tasks. */
async function latestPrUrlByTask(taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (taskIds.length === 0) return out;
  const rows = await db
    .select({ taskId: agentSessions.taskId, prUrl: agentSessions.prUrl })
    .from(agentSessions)
    .where(and(inArray(agentSessions.taskId, taskIds), isNotNull(agentSessions.prUrl)))
    .orderBy(asc(agentSessions.id));
  // Ascending by id → the last write per task wins, i.e. the most recent run.
  for (const r of rows) {
    if (r.taskId && r.prUrl) out.set(r.taskId, r.prUrl);
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Attachment hydration helpers
// ──────────────────────────────────────────────────────────

// Column set excluding the `content` BLOB — list/hydrate paths never need the
// bytes, and pulling megabytes of image data into every task/plan query would
// be wasteful. The download route and getAttachment() select content explicitly.
const ATTACHMENT_META_COLUMNS = {
  id: attachments.id,
  planId: attachments.planId,
  taskId: attachments.taskId,
  filename: attachments.filename,
  mimeType: attachments.mimeType,
  kind: attachments.kind,
  sizeBytes: attachments.sizeBytes,
  author: attachments.author,
  createdAt: attachments.createdAt,
} as const;

function toAttachmentMeta(row: {
  id: number;
  planId: string | null;
  taskId: string | null;
  filename: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  author: string;
  createdAt: Date;
}): AttachmentMeta {
  return {
    id: row.id,
    planId: row.planId,
    taskId: row.taskId,
    filename: row.filename,
    mimeType: row.mimeType,
    kind: row.kind as AttachmentKind,
    sizeBytes: row.sizeBytes,
    author: row.author,
    createdAt: row.createdAt,
  };
}

async function attachmentsForTask(taskId: string): Promise<AttachmentMeta[]> {
  return (await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(asc(attachments.id)))
    .map(toAttachmentMeta);
}

async function attachmentsForPlan(planId: string): Promise<AttachmentMeta[]> {
  return (await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(eq(attachments.planId, planId))
    .orderBy(asc(attachments.id)))
    .map(toAttachmentMeta);
}

async function attachmentsForTasks(taskIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
  const out = new Map<string, AttachmentMeta[]>();
  for (const id of taskIds) out.set(id, []);
  if (taskIds.length === 0) return out;
  const rows = await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(inArray(attachments.taskId, taskIds))
    .orderBy(asc(attachments.id));
  for (const r of rows) {
    if (!r.taskId) continue;
    out.get(r.taskId)?.push(toAttachmentMeta(r));
  }
  return out;
}

async function attachmentsForPlans(planIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
  const out = new Map<string, AttachmentMeta[]>();
  for (const id of planIds) out.set(id, []);
  if (planIds.length === 0) return out;
  const rows = await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(inArray(attachments.planId, planIds))
    .orderBy(asc(attachments.id));
  for (const r of rows) {
    if (!r.planId) continue;
    out.get(r.planId)?.push(toAttachmentMeta(r));
  }
  return out;
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

export async function listPlans(): Promise<PlanFull[]> {
  const rows = await db.select().from(plans).orderBy(asc(plans.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const byPlan = await reposForPlans(ids);
  const attByPlan = await attachmentsForPlans(ids);
  return rows.map((r) =>
    hydratePlan(r, byPlan.get(r.id) ?? [], attByPlan.get(r.id) ?? [])
  );
}

export async function getPlan(id: string): Promise<PlanFull | null> {
  const row = (await db.select().from(plans).where(eq(plans.id, id)))[0];
  return row ? hydratePlan(row, await reposForPlan(id), await attachmentsForPlan(id)) : null;
}

export async function planProgress(planId: string): Promise<PlanProgress> {
  const all = await db
    .select({ state: tasks.state })
    .from(tasks)
    .where(eq(tasks.planId, planId));
  const active = all.filter((t) => t.state !== "cancelled");
  const total = active.length;
  // `merged` is the sole success terminal — the completion count for a plan.
  const done = active.filter((t) => t.state === "merged").length;
  const open = active.filter((t) => t.state !== "merged").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, pct, open };
}

// Batched planProgress for N plans in a single GROUP BY query. Returns
// a Map keyed by plan id; plans with no tasks are still present with
// zeroed counts so callers can index unconditionally.
export async function planProgressBatch(planIds: string[]): Promise<Map<string, PlanProgress>> {
  const out = new Map<string, PlanProgress>();
  for (const id of planIds) out.set(id, { total: 0, done: 0, pct: 0, open: 0 });
  if (planIds.length === 0) return out;
  const rows = await db
    .select({ planId: tasks.planId, state: tasks.state, n: count() })
    .from(tasks)
    .where(inArray(tasks.planId, planIds))
    .groupBy(tasks.planId, tasks.state);
  // First pass: accumulate totals and done.
  for (const r of rows) {
    if (r.state === "cancelled") continue;
    const p = out.get(r.planId)!;
    p.total += Number(r.n);
    if (r.state === "merged") p.done += Number(r.n);
  }
  for (const p of out.values()) {
    p.open = p.total - p.done;
    p.pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
  }
  return out;
}

/** Batched plan-title lookup — one IN query instead of getPlan() per id. */
export async function planTitlesByIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: plans.id, title: plans.title })
    .from(plans)
    .where(inArray(plans.id, ids));
  for (const r of rows) out.set(r.id, r.title);
  return out;
}

// ──────────────────────────────────────────────────────────
// Task queries
// ──────────────────────────────────────────────────────────

export interface TaskFilters {
  state?: TaskState;
  planId?: string;
  assignee?: string;
  /** Restrict to these task ids — batch hydration for read paths that would
   *  otherwise call getTask() per id. */
  ids?: string[];
}

export async function listTasks(filters: TaskFilters = {}): Promise<TaskFull[]> {
  if (filters.ids && filters.ids.length === 0) return [];
  const wheres = [];
  if (filters.state) wheres.push(eq(tasks.state, filters.state));
  if (filters.planId) wheres.push(eq(tasks.planId, filters.planId));
  if (filters.assignee) wheres.push(eq(tasks.assignee, filters.assignee));
  if (filters.ids) wheres.push(inArray(tasks.id, filters.ids));
  const where = wheres.length ? and(...wheres) : undefined;
  const rows = where
    ? await db.select().from(tasks).where(where).orderBy(asc(tasks.id))
    : await db.select().from(tasks).orderBy(asc(tasks.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const depRows = await db
    .select()
    .from(taskDependencies)
    .where(inArray(taskDependencies.taskId, ids));
  const noteRows = await db
    .select()
    .from(taskNotes)
    .where(inArray(taskNotes.taskId, ids))
    .orderBy(asc(taskNotes.createdAt));
  const critRows = await db
    .select()
    .from(acceptanceCriteria)
    .where(inArray(acceptanceCriteria.taskId, ids))
    .orderBy(asc(acceptanceCriteria.position));
  const depsByTask = groupBy(depRows, (r) => r.taskId);
  const notesByTask = groupBy(noteRows, (r) => r.taskId);
  const critsByTask = groupBy(critRows, (r) => r.taskId);
  const attByTask = await attachmentsForTasks(ids);
  const prByTask = await latestPrUrlByTask(ids);
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
      })),
      attByTask.get(r.id) ?? [],
      prByTask.get(r.id) ?? null
    )
  );
}

/** Lean projection of every task — enough for index-page counts and the
 *  palette without hydrating deps, notes, criteria, and attachments. */
export interface TaskSummaryRow {
  id: string;
  title: string;
  planId: string;
  state: TaskState;
}

export async function listTaskSummaries(): Promise<TaskSummaryRow[]> {
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, planId: tasks.planId, state: tasks.state })
    .from(tasks)
    .orderBy(asc(tasks.id));
  return rows.map((r) => ({ ...r, state: r.state as TaskState }));
}

export async function getTask(id: string): Promise<TaskFull | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (!row) return null;
  const deps = (await db
    .select({ dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, id)))
    .map((r) => r.dependsOnId);
  const notes = (await db
    .select()
    .from(taskNotes)
    .where(eq(taskNotes.taskId, id))
    .orderBy(asc(taskNotes.createdAt)))
    .map((n) => ({ id: n.id, author: n.author, body: n.body, createdAt: n.createdAt }));
  const criteria = (await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, id))
    .orderBy(asc(acceptanceCriteria.position)))
    .map((c) => ({ id: c.id, text: c.text, done: c.done, position: c.position }));
  return hydrateTask(
    row,
    deps,
    notes,
    criteria,
    await attachmentsForTask(id),
    (await latestPrUrlByTask([id])).get(id) ?? null
  );
}

// ──────────────────────────────────────────────────────────
// Attached run (one canonical worktree session per task)
// ──────────────────────────────────────────────────────────

/** Minimal view of a task's attached run for the UI + open-or-create endpoint. */
export interface AttachedRunRef {
  id: number;
  status: string;
  cwdStrategy: string;
  prUrl: string | null;
  branch: string | null;
}

/** A `closed` attached run is treated as absent — the next interaction mints a
 *  fresh one. `failed`/`cancelled` are reused (their worktree/branch persist). */
export function isUsableAttachedRun(status: string): boolean {
  return status !== "closed";
}

/**
 * Resolve a task's attached run, or null when unset, deleted, or `closed`.
 * Does not import lib/runs (avoids a cycle) — reads the agent_runs row directly.
 */
export async function resolveAttachedRun(taskId: string): Promise<AttachedRunRef | null> {
  const t = (await db
    .select({ rid: tasks.attachedRunId })
    .from(tasks)
    .where(eq(tasks.id, taskId)))[0];
  if (!t?.rid) return null;
  const r = (await db
    .select({
      id: agentSessions.id,
      status: agentSessions.status,
      cwdStrategy: agentSessions.cwdStrategy,
      prUrl: agentSessions.prUrl,
      branch: agentSessions.branch,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, t.rid)))[0];
  if (!r) return null;
  if (!isUsableAttachedRun(r.status)) return null;
  return r;
}

/**
 * Point a task at its attached run. With `ifUnset`, no-ops when the task already
 * has a usable attached run (so executor-spawned runs only adopt an empty slot).
 */
export async function attachRunToTask(
  taskId: string,
  runId: number,
  opts: { ifUnset?: boolean } = {}
): Promise<void> {
  if (!opts.ifUnset) {
    await db.update(tasks).set({ attachedRunId: runId }).where(eq(tasks.id, taskId));
    return;
  }
  // ifUnset must be atomic: a check-then-set (resolveAttachedRun + UPDATE) lets
  // two concurrent runs both observe an empty slot and clobber each other. Lock
  // the task row FOR UPDATE, re-resolve the current attached run under the lock,
  // and only claim the slot when it's still empty/unusable.
  await db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ id: tasks.id, rid: tasks.attachedRunId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .for("update")
    )[0];
    if (!row) return;
    // Re-check the current attachment UNDER the lock using tx. Calling the
    // db-scoped resolveAttachedRun here would grab a second pool connection
    // while this transaction holds one, risking pool starvation/deadlock and
    // reading outside the FOR UPDATE lock we just took.
    if (row.rid) {
      const r = (
        await tx
          .select({ status: agentSessions.status })
          .from(agentSessions)
          .where(eq(agentSessions.id, row.rid))
      )[0];
      if (r && isUsableAttachedRun(r.status)) return;
    }
    await tx.update(tasks).set({ attachedRunId: runId }).where(eq(tasks.id, taskId));
  });
}

/** Distinct non-null assignees observed across all tasks, alphabetical. */
export async function listAssignees(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ assignee: tasks.assignee })
    .from(tasks)
    .where(sql`${tasks.assignee} IS NOT NULL AND ${tasks.assignee} != ''`)
    .orderBy(asc(tasks.assignee));
  return rows.map((r) => r.assignee!).filter(Boolean);
}

export async function taskCountsByState(): Promise<Record<TaskState, number>> {
  const rows = await db
    .select({ state: tasks.state, n: count() })
    .from(tasks)
    .groupBy(tasks.state);
  const out: Record<TaskState, number> = {
    todo: 0,
    in_progress: 0,
    testing: 0,
    failing: 0,
    passing: 0,
    merged: 0,
    blocked: 0,
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

export async function createPlan(input: CreatePlanInput): Promise<PlanFull> {
  const date = input.date ?? today();
  const id = input.id ?? planIdFromTitle(input.title, date);
  if ((await db.select().from(plans).where(eq(plans.id, id)))[0]) {
    throw new RepoError(`Plan ${id} already exists`, 409);
  }
  const explicitRepos = input.repoIds;
  const repoIds = explicitRepos
    ? Array.from(new Set(explicitRepos.filter((r): r is string => Boolean(r))))
    : await (async () => {
        const fallback = await defaultRepoId();
        return fallback ? [fallback] : [];
      })();
  // Validate each before any insert so the plan isn't created half-attached.
  for (const rid of repoIds) {
    if (!(await getRepository(rid))) throw new RepoError(`Repository ${rid} not found`, 404);
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(plans)
      .values({
        id,
        title: input.title,
        state: input.state ?? "draft",
        owner: input.owner ?? null,
        body: input.body ?? "",
        tags: JSON.stringify(input.tags ?? []),
        createdAt: now,
        updatedAt: now,
      });
    if (repoIds.length > 0) {
      await tx.insert(planRepositories)
        .values(repoIds.map((r, i) => ({ planId: id, repoId: r, position: i })));
    }
  });
  return (await getPlan(id))!;
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

export async function updatePlan(id: string, patch: UpdatePlanInput): Promise<PlanFull> {
  // M17b: same TOCTOU as transitionTask (see its comment) — the PLAN_TRANSITIONS
  // guard used to run against a pre-write snapshot with awaits (repo validation)
  // in between, so two concurrent state-changing updatePlan calls could both
  // pass the guard against the same stale state. Lock the plan row FOR UPDATE
  // inside the transaction and re-derive the guard from the locked read so
  // concurrent transitions serialize instead of racing.
  await db.transaction(async (tx) => {
    const row = (
      await tx.select().from(plans).where(eq(plans.id, id)).for("update")
    )[0];
    if (!row) throw new RepoError(`Plan ${id} not found`, 404);
    const existingState = row.state as PlanState;
    if (patch.state && patch.state !== existingState) {
      const allowed = PLAN_TRANSITIONS[existingState];
      if (!allowed.includes(patch.state)) {
        throw new RepoError(
          `Cannot transition plan ${existingState} → ${patch.state}`,
          400
        );
      }
    }
    if (patch.repoIds) {
      for (const rid of patch.repoIds) {
        if (!(await getRepository(rid))) throw new RepoError(`Repository ${rid} not found`, 404);
      }
    }
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.state !== undefined) values.state = patch.state;
    if (patch.owner !== undefined) values.owner = patch.owner;
    if (patch.body !== undefined) values.body = patch.body;
    if (patch.tags !== undefined) values.tags = JSON.stringify(patch.tags);
    await tx.update(plans).set(values).where(eq(plans.id, id));
    if (patch.repoIds !== undefined) {
      await tx.delete(planRepositories).where(eq(planRepositories.planId, id));
      const unique = Array.from(new Set(patch.repoIds));
      if (unique.length > 0) {
        await tx.insert(planRepositories)
          .values(unique.map((r, i) => ({ planId: id, repoId: r, position: i })));
      }
      // Unpin any task of this plan whose repo is no longer in the plan's set,
      // mirroring removePlanRepository. Otherwise a task stays pinned to a repo
      // the plan no longer spans (stranding it for resolveRepoForTask). The
      // empty-set case (unique === []) nulls every pinned task.
      const stale = unique.length > 0
        ? and(
            eq(tasks.planId, id),
            isNotNull(tasks.repoId),
            notInArray(tasks.repoId, unique)
          )
        : and(eq(tasks.planId, id), isNotNull(tasks.repoId));
      await tx.update(tasks).set({ repoId: null, updatedAt: new Date() }).where(stale);
    }
  });
  return (await getPlan(id))!;
}

// Granular helpers — preferred over `updatePlan({ repoIds })` for adding /
// removing a single repo from a plan because they don't disturb position
// ordering of the unaffected repos.
export async function addPlanRepository(planId: string, repoId: string): Promise<PlanFull> {
  const plan = await getPlan(planId);
  if (!plan) throw new RepoError(`Plan ${planId} not found`, 404);
  if (!(await getRepository(repoId))) throw new RepoError(`Repository ${repoId} not found`, 404);
  if (plan.repos.some((r) => r.id === repoId)) return plan;
  await db.transaction(async (tx) => {
    // Lock the plan row FOR UPDATE so the MAX(position)+1 read and the insert
    // are serialized: two concurrent adds would otherwise both read the same
    // MAX and insert duplicate positions.
    await tx.select({ id: plans.id }).from(plans).where(eq(plans.id, planId)).for("update");
    // Derive the next position from MAX(position)+1 rather than the row count:
    // removePlanRepository doesn't compact positions, so a count would collide
    // with an existing row after a removal and corrupt append order (which in
    // turn changes p.repos[0], the primary for plan-level runs).
    const last = (await tx
      .select({ p: sql<number>`COALESCE(MAX(${planRepositories.position}), -1)` })
      .from(planRepositories)
      .where(eq(planRepositories.planId, planId)))[0];
    const nextPosition = (last?.p ?? -1) + 1;
    await tx.insert(planRepositories)
      .values({ planId, repoId, position: nextPosition });
    await tx.update(plans).set({ updatedAt: new Date() }).where(eq(plans.id, planId));
  });
  return (await getPlan(planId))!;
}

export async function removePlanRepository(planId: string, repoId: string): Promise<PlanFull> {
  const plan = await getPlan(planId);
  if (!plan) throw new RepoError(`Plan ${planId} not found`, 404);
  // Clear repoId on any task pinned to the repo being removed so we don't
  // leave dangling references that the resolver can't satisfy.
  await db.transaction(async (tx) => {
    await tx.delete(planRepositories)
      .where(
        and(eq(planRepositories.planId, planId), eq(planRepositories.repoId, repoId))
      );
    await tx.update(tasks)
      .set({ repoId: null, updatedAt: new Date() })
      .where(and(eq(tasks.planId, planId), eq(tasks.repoId, repoId)));
    await tx.update(plans).set({ updatedAt: new Date() }).where(eq(plans.id, planId));
  });
  return (await getPlan(planId))!;
}

export async function deletePlan(id: string) {
  await db.delete(plans).where(eq(plans.id, id));
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

export async function createTask(input: CreateTaskInput): Promise<TaskFull> {
  const plan = await getPlan(input.planId);
  if (!plan) {
    throw new RepoError(`Plan ${input.planId} not found`, 404);
  }
  const date = input.date ?? today();
  let id = input.id ?? await nextTaskId(date);
  if ((await db.select().from(tasks).where(eq(tasks.id, id)))[0]) {
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

  const deps = Array.from(new Set(input.dependencies ?? []));
  if (deps.length > 0) {
    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, deps));
    const found = new Set(existing.map((r) => r.id));
    const missing = deps.filter((d) => !found.has(d));
    if (missing.length > 0) {
      throw new RepoError(`Dependencies not found: ${missing.join(", ")}`, 400);
    }
  }
  const now = new Date();
  // nextTaskId's MAX-scan → insert is a TOCTOU: two concurrent createTask
  // calls on the same date compute the same id and the loser hits the PK.
  // For auto-generated ids, regenerate and retry instead of surfacing a raw
  // unique-violation (opaque 500) to the caller.
  for (let attempt = 0; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(tasks)
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
          });
        if (deps.length > 0) {
          await tx.insert(taskDependencies)
            .values(deps.map((d) => ({ taskId: id, dependsOnId: d })));
        }
        if (input.criteria?.length) {
          await tx.insert(acceptanceCriteria)
            .values(
              input.criteria.map((text, i) => ({
                taskId: id,
                text,
                done: false,
                position: i,
              }))
            );
        }
      });
      break;
    } catch (err) {
      if (isUniqueViolation(err)) {
        if (input.id === undefined && attempt < 3) {
          id = await nextTaskId(date);
          continue;
        }
        throw new RepoError(`Task ${id} already exists`, 409);
      }
      throw err;
    }
  }
  return (await getTask(id))!;
}

export async function updateTask(
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
): Promise<TaskFull> {
  const existing = await getTask(id);
  if (!existing) throw new RepoError(`Task ${id} not found`, 404);
  if (patch.repoId !== undefined && patch.repoId !== null) {
    const plan = await getPlan(existing.planId);
    const planRepoIds = plan?.repos.map((r) => r.id) ?? [];
    if (!planRepoIds.includes(patch.repoId)) {
      throw new RepoError(
        `Repository ${patch.repoId} is not attached to plan ${existing.planId}. Attach it first or pick from: ${planRepoIds.join(", ") || "(none)"}`,
        400
      );
    }
  }
  // Validate dependencies up front (createTask does; updateTask historically did
  // not, so missing ids surfaced as raw FK 500s and self/duplicate deps slipped
  // through). Dedupe, reject self-dependency, then verify every id exists.
  let deps: string[] | undefined;
  if (patch.dependencies !== undefined) {
    deps = Array.from(new Set(patch.dependencies));
    if (deps.includes(id)) {
      throw new RepoError(`Task ${id} cannot depend on itself`, 400);
    }
    if (deps.length > 0) {
      const existingDeps = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(inArray(tasks.id, deps));
      const found = new Set(existingDeps.map((r) => r.id));
      const missing = deps.filter((d) => !found.has(d));
      if (missing.length > 0) {
        throw new RepoError(`Dependencies not found: ${missing.join(", ")}`, 400);
      }
    }
  }
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.assignee !== undefined) values.assignee = patch.assignee;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.estimate !== undefined) values.estimate = patch.estimate;
  if (patch.tags !== undefined) values.tags = JSON.stringify(patch.tags);
  if (patch.repoId !== undefined) values.repoId = patch.repoId;
  await db.transaction(async (tx) => {
    await tx.update(tasks).set(values).where(eq(tasks.id, id));
    if (deps !== undefined) {
      await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, id));
      if (deps.length > 0) {
        await tx.insert(taskDependencies)
          .values(deps.map((d) => ({ taskId: id, dependsOnId: d })));
      }
    }
  });
  return (await getTask(id))!;
}

export interface TransitionInput {
  state: TaskState;
  assignee?: string;
  note?: string;
  /**
   * Enforce the acceptance-criteria gate on the `merged` terminal. Off by
   * default: at the repo layer criteria are informational and never block a
   * transition (the PR-merge sync in pr-task-state.ts and ci-autofix depend on
   * this — a PR already merged on GitHub must always reflect into task state).
   * The agent-facing `transition_task` tool opts in so an agent can't hand-merge
   * a task with unchecked criteria.
   */
  enforceCriteria?: boolean;
}

export async function transitionTask(id: string, input: TransitionInput): Promise<TaskFull> {
  // M17a: the read (getTask), the TASK_TRANSITIONS guard, and the
  // done-criteria gate all used to run against a snapshot taken *before* the
  // write, with awaits in between — any interleaving (e.g. a human's
  // review→cancelled racing the PR-merge poller's review→done) let both
  // callers pass the guard against the same stale row and the loser's write
  // would silently clobber the winner's terminal state. Locking the task row
  // with SELECT ... FOR UPDATE inside a single transaction serializes
  // concurrent transitions: the second caller blocks until the first commits,
  // then re-derives prev/assignee/criteria from the now-current row, so a
  // transition that's no longer legal (e.g. the task already left `review`)
  // is rejected instead of silently applied.
  await db.transaction(async (tx) => {
    const row = (
      await tx.select().from(tasks).where(eq(tasks.id, id)).for("update")
    )[0];
    if (!row) throw new RepoError(`Task ${id} not found`, 404);
    const prev = row.state as TaskState;
    if (input.state !== prev) {
      const allowed = TASK_TRANSITIONS[prev];
      if (!allowed.includes(input.state)) {
        throw new RepoError(
          `Cannot transition ${prev} → ${input.state}. Allowed: ${allowed.join(", ") || "(terminal)"}`,
          400
        );
      }
    }
    const assignee = input.assignee ?? row.assignee ?? undefined;
    if (input.state === "in_progress" && !assignee) {
      throw new RepoError("Going to in_progress requires an assignee", 400);
    }
    // done-criteria gate: `merged` is the success terminal, and (when the caller
    // opts in via enforceCriteria) it's rejected while any acceptance criterion
    // is still open. Runs inside the same FOR UPDATE transaction as the guard
    // above so a criterion can't be unchecked between the check and the write.
    // Only fires on an actual transition into `merged` (not a no-op when already
    // merged); zero criteria means nothing to gate, so an empty set is allowed.
    if (input.enforceCriteria && input.state === "merged" && input.state !== prev) {
      const [openRow] = await tx
        .select({ n: count() })
        .from(acceptanceCriteria)
        .where(and(eq(acceptanceCriteria.taskId, id), eq(acceptanceCriteria.done, false)));
      const open = Number(openRow?.n ?? 0);
      if (open > 0) {
        throw new RepoError(
          `Cannot transition ${prev} → ${input.state}: ${open} acceptance ${open === 1 ? "criterion is" : "criteria are"} still open. Check them off first.`,
          400
        );
      }
    }
    const now = new Date();
    await tx.update(tasks)
      .set({ state: input.state, assignee: assignee ?? null, updatedAt: now })
      .where(eq(tasks.id, id));
    if (input.note || input.state !== prev) {
      const body = input.note ?? `→ ${input.state}`;
      await tx.insert(taskNotes)
        .values({ taskId: id, author: assignee ?? "system", body, createdAt: now });
    }
  });
  return (await getTask(id))!;
}

export async function deleteTask(id: string) {
  await db.delete(tasks).where(eq(tasks.id, id));
}

/**
 * Record a task's explicit PR link (set_task_pr tool). This is the
 * authoritative source hydrateTask reads first — distinct from the
 * session-derived "latest run's PR" fallback used until an implementor
 * actually calls the tool. Does not touch task state; callers decide whether
 * a transition is also warranted.
 */
export async function setTaskPr(taskId: string, prUrl: string): Promise<void> {
  // Store the canonical form so getTaskByPrUrl (and the frequent PR-sync poller)
  // can do an indexed equality lookup instead of scanning + canonicalizing every
  // row. Fall back to the raw value only if it doesn't parse as a PR url.
  const canonical = canonicalizePrUrl(prUrl) ?? prUrl;
  await db
    .update(tasks)
    .set({ prUrl: canonical, updatedAt: new Date() })
    .where(eq(tasks.id, taskId));
}

/**
 * Resolve the task whose explicit `tasks.pr_url` link matches the given PR url.
 * This is the authoritative task↔PR link the GitHub webhook/poller prefer over
 * the older run-based (`agent_sessions.pr_url`/branch) heuristic. Comparison is
 * canonical (case-insensitive, fragment/`.git`-stripped) so a webhook's
 * lowercased url matches a mixed-case stored link. Returns null when no task
 * carries a matching pr_url. Deterministic (lowest task id) if several do.
 */
export async function getTaskByPrUrl(prUrl: string): Promise<TaskFull | null> {
  const key = canonicalizePrUrl(prUrl);
  if (!key) return null;
  // Fast path: indexed equality against the canonical value setTaskPr stores
  // (tasks_pr_url_idx). Avoids scanning + canonicalizing every PR-backed task on
  // each webhook delivery and every ~20s poll tick.
  const [hit] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.prUrl, key))
    .orderBy(asc(tasks.id))
    .limit(1);
  if (hit) return getTask(hit.id);
  // Legacy fallback: rows written before canonicalize-on-write may hold a
  // non-canonical url; scan + canonicalize to match those.
  const rows = await db
    .select({ id: tasks.id, prUrl: tasks.prUrl })
    .from(tasks)
    .where(isNotNull(tasks.prUrl))
    .orderBy(asc(tasks.id));
  const match = rows.find((r) => canonicalizePrUrl(r.prUrl) === key);
  return match ? getTask(match.id) : null;
}

// ──────────────────────────────────────────────────────────
// Notes
// ──────────────────────────────────────────────────────────

export async function addNote(taskId: string, author: string, body: string) {
  if (!(await getTask(taskId))) throw new RepoError(`Task ${taskId} not found`, 404);
  await db.insert(taskNotes)
    .values({ taskId, author, body, createdAt: new Date() });
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
}

// ──────────────────────────────────────────────────────────
// Acceptance criteria
// ──────────────────────────────────────────────────────────

export async function addCriterion(taskId: string, text: string) {
  if (!(await getTask(taskId))) throw new RepoError(`Task ${taskId} not found`, 404);
  await db.transaction(async (tx) => {
    // Lock the task row FOR UPDATE so the MAX(position)+1 read and the insert
    // are serialized: two concurrent adds would otherwise both read the same
    // MAX and insert colliding positions.
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).for("update");
    const lastPos = (await tx
      .select({ p: sql<number>`COALESCE(MAX(${acceptanceCriteria.position}), -1)` })
      .from(acceptanceCriteria)
      .where(eq(acceptanceCriteria.taskId, taskId)))[0];
    const pos = (lastPos?.p ?? -1) + 1;
    await tx.insert(acceptanceCriteria)
      .values({ taskId, text, done: false, position: pos });
    await tx.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, taskId));
  });
}

export async function updateCriterion(
  criterionId: number,
  patch: { done?: boolean; text?: string },
  // When provided, the criterion must belong to this task — callers addressing
  // a criterion through a task-scoped URL must not reach another task's rows.
  taskId?: string
) {
  const row = (await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.id, criterionId)))[0];
  if (!row || (taskId !== undefined && row.taskId !== taskId)) {
    throw new RepoError(`Criterion ${criterionId} not found`, 404);
  }
  const values: Record<string, unknown> = {};
  if (patch.done !== undefined) values.done = patch.done;
  if (patch.text !== undefined) values.text = patch.text;
  // An empty patch would make drizzle throw 'No values to set' (→ HTTP 500).
  // Treat it as a no-op instead. (updateCriterionSchema also refines this away.)
  if (Object.keys(values).length === 0) return;
  await db.update(acceptanceCriteria).set(values).where(eq(acceptanceCriteria.id, criterionId));
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId));
}

export async function deleteCriterion(criterionId: number, taskId?: string) {
  const row = (await db
    .select()
    .from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.id, criterionId)))[0];
  if (!row || (taskId !== undefined && row.taskId !== taskId)) return;
  await db.delete(acceptanceCriteria).where(eq(acceptanceCriteria.id, criterionId));
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, row.taskId));
}

// ──────────────────────────────────────────────────────────
// Attachments (images & artifacts on plans/tasks)
// ──────────────────────────────────────────────────────────

// Cap per-attachment size. Bytes live inline in the SQLite BLOB, so this is a
// guard against a single upload bloating the DB file. 25 MiB comfortably fits
// screenshots, logs, and small artifacts; larger blobs belong in object
// storage, which this orchestrator deliberately avoids.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function attachmentKindForMime(mimeType: string): AttachmentKind {
  return mimeType.toLowerCase().startsWith("image/") ? "image" : "artifact";
}

export interface AddAttachmentInput {
  /** Exactly one of planId / taskId must be set. */
  planId?: string | null;
  taskId?: string | null;
  filename: string;
  mimeType: string;
  content: Buffer;
  author: string;
}

export async function addAttachment(input: AddAttachmentInput): Promise<AttachmentMeta> {
  const planId = input.planId ?? null;
  const taskId = input.taskId ?? null;
  if ((planId === null) === (taskId === null)) {
    throw new RepoError(
      "An attachment must belong to exactly one of plan_id or task_id",
      400
    );
  }
  if (planId !== null && !(await getPlan(planId))) {
    throw new RepoError(`Plan ${planId} not found`, 404);
  }
  if (taskId !== null && !(await getTask(taskId))) {
    throw new RepoError(`Task ${taskId} not found`, 404);
  }
  const filename = input.filename.trim() || "attachment";
  const mimeType = input.mimeType.trim() || "application/octet-stream";
  if (!input.content || input.content.length === 0) {
    throw new RepoError("Attachment content is empty", 400);
  }
  if (input.content.length > MAX_ATTACHMENT_BYTES) {
    throw new RepoError(
      `Attachment too large: ${input.content.length} bytes (max ${MAX_ATTACHMENT_BYTES})`,
      413
    );
  }
  const now = new Date();
  const inserted = await db
    .insert(attachments)
    .values({
      planId,
      taskId,
      filename,
      mimeType,
      kind: attachmentKindForMime(mimeType),
      sizeBytes: input.content.length,
      content: input.content,
      author: input.author,
      createdAt: now,
    })
    .returning({
      id: attachments.id,
      planId: attachments.planId,
      taskId: attachments.taskId,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      kind: attachments.kind,
      sizeBytes: attachments.sizeBytes,
      author: attachments.author,
      createdAt: attachments.createdAt,
    });
  // Touch the owner's updated_at so list views re-sort and SSR re-renders.
  if (planId !== null) {
    await db.update(plans).set({ updatedAt: now }).where(eq(plans.id, planId));
  } else if (taskId !== null) {
    await db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, taskId));
  }
  return toAttachmentMeta(inserted[0]);
}

export interface ListAttachmentsFilter {
  planId?: string;
  taskId?: string;
}

export async function listAttachments(filter: ListAttachmentsFilter): Promise<AttachmentMeta[]> {
  if (filter.taskId) return attachmentsForTask(filter.taskId);
  if (filter.planId) return attachmentsForPlan(filter.planId);
  return (await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .orderBy(desc(attachments.id)))
    .map(toAttachmentMeta);
}

export async function getAttachmentMeta(id: number): Promise<AttachmentMeta | null> {
  const row = (await db
    .select(ATTACHMENT_META_COLUMNS)
    .from(attachments)
    .where(eq(attachments.id, id)))[0];
  return row ? toAttachmentMeta(row) : null;
}

export interface AttachmentWithContent extends AttachmentMeta {
  content: Buffer;
}

/** Full attachment including the BLOB bytes — for downloads and the agent. */
export async function getAttachment(id: number): Promise<AttachmentWithContent | null> {
  const row = (await db.select().from(attachments).where(eq(attachments.id, id)))[0];
  if (!row) return null;
  return {
    ...toAttachmentMeta(row as AttachmentRow),
    content: row.content as Buffer,
  };
}

export async function deleteAttachment(id: number) {
  const row = (await db
    .select({ id: attachments.id, planId: attachments.planId, taskId: attachments.taskId })
    .from(attachments)
    .where(eq(attachments.id, id)))[0];
  if (!row) return;
  const now = new Date();
  await db.delete(attachments).where(eq(attachments.id, id));
  if (row.planId) {
    await db.update(plans).set({ updatedAt: now }).where(eq(plans.id, row.planId));
  } else if (row.taskId) {
    await db.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, row.taskId));
  }
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

export async function listRepositories(): Promise<RepositoryRow[]> {
  return (await db
    .select()
    .from(repositories)
    .orderBy(asc(repositories.id)))
    .map(hydrateRepository);
}

export async function getRepository(id: string): Promise<RepositoryRow | null> {
  const row = (await db.select().from(repositories).where(eq(repositories.id, id)))[0];
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

export async function createRepository(input: CreateRepositoryInput): Promise<RepositoryRow> {
  if (!input.name.trim()) throw new RepoError("Repository name is required", 400);
  const id = input.id?.trim() || repoIdFromName(input.name);
  if (!id) throw new RepoError("Repository id could not be derived", 400);
  if ((await db.select().from(repositories).where(eq(repositories.id, id)))[0]) {
    throw new RepoError(`Repository ${id} already exists`, 409);
  }
  const now = new Date();
  await db.insert(repositories)
    .values({
      id,
      name: input.name.trim(),
      remote: input.remote?.trim() || null,
      localPath: input.localPath?.trim() || null,
      defaultBranch: (input.defaultBranch ?? "main").trim() || "main",
      description: input.description ?? "",
      createdAt: now,
      updatedAt: now,
    });
  return (await getRepository(id))!;
}

export interface UpdateRepositoryInput {
  name?: string;
  remote?: string | null;
  localPath?: string | null;
  defaultBranch?: string;
  description?: string;
}

export async function updateRepository(id: string, patch: UpdateRepositoryInput): Promise<RepositoryRow> {
  const existing = await getRepository(id);
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
  await db.update(repositories).set(values).where(eq(repositories.id, id));
  return (await getRepository(id))!;
}

export async function deleteRepository(id: string) {
  const existing = await getRepository(id);
  if (!existing) return;
  // Block deletion if anything still references this repo — orphaning is
  // worse than the friction of an explicit reassignment.
  const planRefs = await db
    .select({ planId: planRepositories.planId })
    .from(planRepositories)
    .where(eq(planRepositories.repoId, id));
  // Since 0009, chats are folded into agent_runs. A chat-derived run is one
  // with legacy_chat_id IS NOT NULL; newly-created chat runs (post-0009)
  // also fit the same shape with goal='<chat>'. Both block deletion the
  // same way agent task runs do via the agentSessions FK.
  const runRefs = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eq(agentSessions.repoId, id));
  if (planRefs.length > 0 || runRefs.length > 0) {
    throw new RepoError(
      `Cannot delete ${id}: ${planRefs.length} plan(s) and ${runRefs.length} run(s) still reference it. Reassign them first.`,
      409
    );
  }
  await db.delete(repositories).where(eq(repositories.id, id));
}

// Resolution helpers — single source of truth for "which repo does this run
// in?". Used by lib/agent.ts (task.repoId pinned at creation) and lib/chat.ts
// (chat.repoId). If a task has no repoId, the agent should escalate rather
// than guess — see the comment on createTask for the resolution rule.
export async function resolveRepoForTask(taskId: string): Promise<RepositoryRow | null> {
  const task = await getTask(taskId);
  if (!task?.repoId) return null;
  return await getRepository(task.repoId);
}

export async function defaultRepoId(): Promise<string | null> {
  // Default repo for newly-created plans/chats: prefer R-default if it's
  // configured (has a local_path), otherwise the first repository with a
  // local_path, otherwise null.
  const seeded = await getRepository(DEFAULT_REPO_ID);
  if (seeded?.localPath) return seeded.id;
  const first = (await listRepositories()).find((r) => r.localPath) ?? (await listRepositories())[0];
  return first?.id ?? null;
}

export async function defaultRepo(): Promise<RepositoryRow | null> {
  const id = await defaultRepoId();
  return id ? await getRepository(id) : null;
}

// ──────────────────────────────────────────────────────────
// Personas
// ──────────────────────────────────────────────────────────

export interface PersonaUpsert {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string | null;
  toolsProfile: string;
  backend?: "pi" | "claude" | null;
  skillPaths: string[];
  budgetMaxTurns?: number | null;
  budgetMaxSeconds?: number | null;
}

export async function getPersona(id: string): Promise<Persona | null> {
  const row = (await db.select().from(personasTable).where(eq(personasTable.id, id)))[0];
  return row ?? null;
}

export async function listPersonaIds(): Promise<string[]> {
  return (await db
    .select({ id: personasTable.id })
    .from(personasTable)
    .orderBy(asc(personasTable.id)))
    .map((r) => r.id);
}

export async function listPersonas(): Promise<Persona[]> {
  return await db.select().from(personasTable).orderBy(asc(personasTable.id));
}

export async function upsertPersona(p: PersonaUpsert): Promise<void> {
  const now = new Date();
  await db.insert(personasTable)
    .values({
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      systemPrompt: p.systemPrompt,
      modelProvider: p.modelProvider ?? "anthropic",
      modelId: p.modelId ?? "claude-opus-4-8",
      thinkingLevel: p.thinkingLevel ?? null,
      toolsProfile: p.toolsProfile,
      backend: p.backend ?? null,
      skillPaths: JSON.stringify(p.skillPaths),
      budgetMaxTurns: p.budgetMaxTurns ?? null,
      budgetMaxSeconds: p.budgetMaxSeconds ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: personasTable.id,
      set: {
        name: p.name,
        description: p.description ?? null,
        systemPrompt: p.systemPrompt,
        modelProvider: p.modelProvider ?? "anthropic",
        modelId: p.modelId ?? "claude-opus-4-8",
        thinkingLevel: p.thinkingLevel ?? null,
        toolsProfile: p.toolsProfile,
        backend: p.backend ?? null,
        skillPaths: JSON.stringify(p.skillPaths),
        budgetMaxTurns: p.budgetMaxTurns ?? null,
        budgetMaxSeconds: p.budgetMaxSeconds ?? null,
        updatedAt: now,
      },
    });
}

// ──────────────────────────────────────────────────────────
// Shared memory
// ──────────────────────────────────────────────────────────

// Shared-memory scopes. `persona`/`user` were added for the Discord persona bots
// (spec 2026-07-31-discord-personas-messaging-design.md §4): scopeKey is the
// persona id / the users.id. There is no DB CHECK constraint on memories.scope —
// this union plus the memory tool schemas in lib/extensions/persona-memory.ts are
// the whole validation surface.
export type MemoryScope = "global" | "repo" | "task" | "persona" | "user";

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  "global",
  "repo",
  "task",
  "persona",
  "user",
] as const;

export function isMemoryScope(value: string): value is MemoryScope {
  return (MEMORY_SCOPES as readonly string[]).includes(value);
}

export interface MemoryCreate {
  scope: MemoryScope;
  scopeKey?: string | null;
  body: string;
  keywords?: string[];
  author?: string;
  createdByRunId?: number | null;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
}

function normalizeKeywords(keywords: string[] | undefined): string[] {
  return Array.from(new Set((keywords ?? [])
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean))).slice(0, 24);
}

function parseKeywords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

function memoryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
}

export async function createMemory(input: MemoryCreate): Promise<Memory> {
  const now = new Date();
  const body = input.body.trim();
  if (!body) throw new RepoError("Memory body is required.", 400);
  if (input.scope !== "global" && !input.scopeKey) {
    throw new RepoError(`Memory scope '${input.scope}' requires a scope key.`, 400);
  }
  const row = (await db.insert(memories)
    .values({
      scope: input.scope,
      scopeKey: input.scope === "global" ? null : input.scopeKey ?? null,
      body,
      keywords: JSON.stringify(normalizeKeywords(input.keywords)),
      author: input.author ?? "agent",
      createdByRunId: input.createdByRunId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning())[0];
  return row;
}

export async function listRecentMemories(args: {
  scopes: Array<{ scope: MemoryScope; scopeKey?: string | null }>;
  limit?: number;
}): Promise<Memory[]> {
  const predicates = args.scopes.map((s) =>
    s.scope === "global"
      ? eq(memories.scope, "global")
      : and(eq(memories.scope, s.scope), eq(memories.scopeKey, s.scopeKey ?? ""))
  );
  if (predicates.length === 0) return [];
  return await db
    .select()
    .from(memories)
    .where(predicates.length === 1 ? predicates[0] : or(...predicates))
    .orderBy(desc(memories.updatedAt), desc(memories.id))
    .limit(Math.max(1, Math.min(args.limit ?? 12, 50)));
}

export async function searchMemories(args: {
  query: string;
  scopes: Array<{ scope: MemoryScope; scopeKey?: string | null }>;
  limit?: number;
}): Promise<MemorySearchResult[]> {
  const queryTokens = Array.from(new Set(memoryTokens(args.query)));
  if (queryTokens.length === 0) return [];
  const candidates = await listRecentMemories({ scopes: args.scopes, limit: 500 });
  if (candidates.length === 0) return [];

  const docs = candidates.map((memory) => {
    const keywords = parseKeywords(memory.keywords);
    const tokens = [
      ...memoryTokens(memory.body),
      ...keywords.flatMap((k) => [k, k, k]).flatMap(memoryTokens),
    ];
    return { memory, tokens, length: Math.max(tokens.length, 1) };
  });
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  const k1 = 1.2;
  const b = 0.75;

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of queryTokens) {
      const tf = doc.tokens.filter((t) => t === term).length;
      if (tf === 0) continue;
      const df = docs.filter((d) => d.tokens.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / avgLen))));
    }
    return { memory: doc.memory, score };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt.getTime() - a.memory.updatedAt.getTime())
    .slice(0, Math.max(1, Math.min(args.limit ?? 8, 25)));
}

export async function removeMemoriesBySubstring(args: {
  scopes: Array<{ scope: MemoryScope; scopeKey?: string | null }>;
  match: string;
}): Promise<number> {
  const rows = await listRecentMemories({ scopes: args.scopes, limit: 500 });
  const needle = args.match.toLowerCase();
  const matching = rows.filter((m) => m.body.toLowerCase().includes(needle));
  if (matching.length === 0) return 0;
  await db.delete(memories).where(inArray(memories.id, matching.map((m) => m.id)));
  return matching.length;
}

export async function getPersonaMemory(personaId: string, scope: string): Promise<string | null> {
  const row = (await db
    .select({ body: personaMemories.body })
    .from(personaMemories)
    .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.scope, scope))))[0];
  return row ? row.body : null;
}

export async function appendPersonaMemory(personaId: string, scope: string, note: string): Promise<void> {
  const now = new Date();
  const trimmed = note.trim();
  if (!trimmed) return;
  const firstBullet = `- ${trimmed}`;
  const appendFragment = `\n- ${trimmed}`;
  await db.insert(personaMemories)
    .values({ personaId, scope, body: firstBullet, updatedAt: now })
    .onConflictDoUpdate({
      target: [personaMemories.personaId, personaMemories.scope],
      set: {
        body: sql`${personaMemories.body} || ${appendFragment}`,
        updatedAt: now,
      },
    });
}

export async function removePersonaMemoryLine(
  personaId: string,
  scope: string,
  match: string
): Promise<number> {
  const body = await getPersonaMemory(personaId, scope);
  if (!body) return 0;
  const lines = body.split("\n");
  const kept = lines.filter((l) => !l.includes(match));
  const removed = lines.length - kept.length;
  if (removed === 0) return 0;
  if (kept.length === 0) {
    await db.delete(personaMemories)
      .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.scope, scope)));
    return removed;
  }
  const now = new Date();
  await db.update(personaMemories)
    .set({ body: kept.join("\n"), updatedAt: now })
    .where(and(eq(personaMemories.personaId, personaId), eq(personaMemories.scope, scope)));
  return removed;
}

// ──────────────────────────────────────────────────────────
// Channel identities
// ──────────────────────────────────────────────────────────

// Maps an external chat account (channel + provider user id, e.g.
// 'discord' + a snowflake) onto a local users row. Written by the pipe's
// `/link <api-token>` DM command after the token verifies; read on every inbound
// message to attribute the conversation's run. Unlinked users simply have no
// row — attribution is an upgrade, not an access gate.

export interface ChannelIdentityUpsert {
  channel: string;
  externalUserId: string;
  userId: number;
  /** Display handle at link time (e.g. the Discord username). */
  label?: string | null;
}

export async function getChannelIdentity(
  channel: string,
  externalUserId: string
): Promise<ChannelIdentity | null> {
  const row = (await db
    .select()
    .from(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.externalUserId, externalUserId)
      )
    ))[0];
  return row ?? null;
}

/** All identities linked to a local user (one per channel account). */
export async function listChannelIdentitiesForUser(userId: number): Promise<ChannelIdentity[]> {
  return await db
    .select()
    .from(channelIdentities)
    .where(eq(channelIdentities.userId, userId))
    .orderBy(asc(channelIdentities.id));
}

/**
 * Link (or re-link) an external account. Re-running `/link` with a token for a
 * different user re-points the existing row, so a mistaken link is fixable
 * without an admin: the unique key is (channel, externalUserId).
 */
export async function upsertChannelIdentity(
  input: ChannelIdentityUpsert
): Promise<ChannelIdentity> {
  const channel = input.channel.trim();
  const externalUserId = input.externalUserId.trim();
  if (!channel) throw new RepoError("Channel is required.", 400);
  if (!externalUserId) throw new RepoError("External user id is required.", 400);
  const row = (await db
    .insert(channelIdentities)
    .values({
      channel,
      externalUserId,
      userId: input.userId,
      label: input.label ?? null,
    })
    .onConflictDoUpdate({
      target: [channelIdentities.channel, channelIdentities.externalUserId],
      set: { userId: input.userId, label: input.label ?? null },
    })
    .returning())[0];
  return row;
}

/** Unlink an external account. Returns true when a row was removed. */
export async function deleteChannelIdentity(
  channel: string,
  externalUserId: string
): Promise<boolean> {
  const removed = await db
    .delete(channelIdentities)
    .where(
      and(
        eq(channelIdentities.channel, channel),
        eq(channelIdentities.externalUserId, externalUserId)
      )
    )
    .returning({ id: channelIdentities.id });
  return removed.length > 0;
}

// ──────────────────────────────────────────────────────────
// Planning stage helper
// ──────────────────────────────────────────────────────────

export type { PlanningStage };

/**
 * Advance the planning_stage on an agent_runs row, enforcing the state
 * machine defined in PLANNING_STAGE_TRANSITIONS.
 */
export async function setPlanningStage(runId: number, stage: PlanningStage): Promise<void> {
  const row = (await db
    .select({ planningStage: agentSessions.planningStage })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId)))[0];
  const current = (row?.planningStage as PlanningStage | null) ?? "gathering";
  const allowed = PLANNING_STAGE_TRANSITIONS[current];
  if (!allowed.includes(stage)) {
    throw new RepoError(
      `Cannot advance planning stage from '${current}' to '${stage}'`,
      409
    );
  }
  await db.update(agentSessions)
    .set({ planningStage: stage })
    .where(eq(agentSessions.id, runId));
}
