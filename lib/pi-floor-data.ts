import * as repo from "@/lib/repo";
import * as runsLib from "@/lib/runs";
import type { TaskState, TaskFull } from "@/lib/types";
import type {
  FloorRun,
  QueueRow,
  ShippedRow,
} from "@/components/pi/factory-floor";
import type { PlanCardData } from "@/components/pi/plans-index";
import type { TaskRowData } from "@/components/pi/tasks-index";
import type { PiState } from "@/components/pi/primitives";
import {
  ACTIVE_STATUSES,
  REVIEW_STATUSES,
  BLOCKED_STATUSES,
  SHIPPED_STATUSES,
  classifyRun,
} from "@/lib/run-buckets";

function shortRunId(id: number, startedAt: Date): string {
  const y = startedAt.getFullYear();
  const m = String(startedAt.getMonth() + 1).padStart(2, "0");
  const d = String(startedAt.getDate()).padStart(2, "0");
  return `R-${y}${m}${d}-${String(id).padStart(3, "0")}`;
}

function fauxSparkline(seed: number): number[] {
  // deterministic gentle ramp based on seed
  const pts: number[] = [];
  let v = 10 + (seed % 17);
  for (let i = 0; i < 20; i++) {
    v += ((seed * (i + 1)) % 9) - 3;
    pts.push(Math.max(1, v));
  }
  return pts;
}

function defaultActivity(task: string): string[] {
  return [
    `Working on "${task.slice(0, 50)}"…`,
    "Reading repo files",
    "Running pnpm typecheck",
    "Editing source files",
  ];
}

type RunWithTask = {
  run: runsLib.RunRow;
  task: TaskFull | null;
  planTitle: string | null;
};

async function loadRunsByGroup(): Promise<{
  running: RunWithTask[];
  review: RunWithTask[];
  blocked: RunWithTask[];
  shipped: RunWithTask[];
}> {
  const allRuns = (await runsLib.listRuns()).filter((r) => r.origin === "task");
  const taskCache = new Map<string, TaskFull | null>();
  const planCache = new Map<string, string | null>();
  async function joinTask(taskId: string | null): Promise<TaskFull | null> {
    if (!taskId) return null;
    if (taskCache.has(taskId)) return taskCache.get(taskId)!;
    const t = await repo.getTask(taskId);
    taskCache.set(taskId, t);
    return t;
  }
  async function planTitle(planId: string | null): Promise<string | null> {
    if (!planId) return null;
    if (planCache.has(planId)) return planCache.get(planId)!;
    const p = await repo.getPlan(planId);
    const title = p?.title ?? null;
    planCache.set(planId, title);
    return title;
  }

  const groups = { running: [] as RunWithTask[], review: [] as RunWithTask[], blocked: [] as RunWithTask[], shipped: [] as RunWithTask[] };
  for (const run of allRuns) {
    const task = await joinTask(run.taskId);
    const plan = await planTitle(task?.planId ?? null);
    const wrapped = { run, task, planTitle: plan };
    const cat = classifyRun(run.status, run.prUrl, task?.state);
    if (cat === "running") groups.running.push(wrapped);
    else if (cat === "review") groups.review.push(wrapped);
    else if (cat === "blocked") groups.blocked.push(wrapped);
    else if (cat === "shipped") groups.shipped.push(wrapped);
  }
  // Return the full shipped list (ordered most-recent-first by listRuns). Callers
  // that render the floor's shipped table truncate to the 8 newest themselves;
  // per-plan shippedCount must count against the full list, not a global top-8.
  return groups;
}

function toFloorRun(w: RunWithTask, kind: "running" | "review" | "blocked"): FloorRun {
  const r = w.run;
  const criteria = w.task?.criteria || [];
  const done = criteria.filter((c) => c.done).length;
  const total = criteria.length;
  const cost = r.totalCostUsd ?? 0;
  const budget = r.budgetMaxUsd ?? 25;
  const prMatch = r.prUrl?.match(/\/pull\/(\d+)/);
  const state: FloorRun["state"] = kind === "running" ? "in_progress" : kind;
  let sub: FloorRun["sub"];
  if (kind === "running") sub = r.status === "preparing" ? "starting" : "editing";
  else if (kind === "blocked") sub = r.status === "budget_exhausted" ? "budget" : "criteria";
  const reason =
    kind === "blocked"
      ? r.status === "budget_exhausted"
        ? `Budget exhausted ($${cost.toFixed(2)} / $${budget.toFixed(0)}).`
        : r.error || "Stopped per stop-rule."
      : undefined;

  return {
    id: shortRunId(r.id, r.startedAt),
    runDbId: r.id,
    state,
    sub,
    task: { id: w.task?.id || r.taskId || "—", title: w.task?.title || r.title || "(untitled run)" },
    plan: w.planTitle,
    persona: r.personaId,
    branch: r.branch,
    pr: prMatch
      ? { num: parseInt(prMatch[1], 10), title: r.title || "", additions: 0, deletions: 0 }
      : null,
    startedAt: r.startedAt.getTime(),
    cost,
    budget,
    tokens: { in: r.inputTokens ?? 0, out: r.outputTokens ?? 0 },
    progress: { done, total },
    activity: defaultActivity(w.task?.title || "this task"),
    sparkline: fauxSparkline(r.id),
    reason,
  };
}

function toShipped(w: RunWithTask): ShippedRow {
  const r = w.run;
  const prMatch = r.prUrl?.match(/\/pull\/(\d+)/);
  return {
    id: shortRunId(r.id, r.startedAt),
    runDbId: r.id,
    task: w.task?.title || r.title || "(untitled)",
    plan: w.planTitle,
    persona: r.personaId,
    branch: r.branch,
    pr: prMatch ? parseInt(prMatch[1], 10) : null,
    cost: r.totalCostUsd ?? 0,
    finishedAt: (r.completedAt ?? r.startedAt).getTime(),
    diff: { additions: 0, deletions: 0 },
  };
}

export async function loadFloorData(): Promise<{
  running: FloorRun[];
  review: FloorRun[];
  blocked: FloorRun[];
  queue: QueueRow[];
  shipped: ShippedRow[];
}> {
  const groups = await loadRunsByGroup();
  const todoTasks = (await repo.listTasks({ state: "todo" })).slice(0, 12);
  const plans = await repo.listPlans();
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

  const queue: QueueRow[] = todoTasks.map((t) => ({
    id: t.id,
    title: t.title,
    plan: planTitleById.get(t.planId) ?? null,
    criteria: t.criteria.length,
    tags: t.tags,
    persona: t.assignee,
  }));

  return {
    running: groups.running.map((g) => toFloorRun(g, "running")),
    review: groups.review.map((g) => toFloorRun(g, "review")),
    blocked: groups.blocked.map((g) => toFloorRun(g, "blocked")),
    queue,
    // The floor's shipped table shows only the 8 most-recent shipped runs; truncate
    // here (not in loadRunsByGroup) so per-plan shippedCount can use the full list.
    shipped: groups.shipped.slice(0, 8).map(toShipped),
  };
}

const PLAN_STATE_TO_PI: Record<string, PiState> = {
  draft: "todo",
  proposed: "todo",
  accepted: "in_progress",
  done: "done",
  cancelled: "cancelled",
};

const TASK_STATE_TO_PI: Record<TaskState, PiState> = {
  todo: "todo",
  in_progress: "in_progress",
  // testing/failing/passing are all "PR open, in flight" — bucket them into the
  // existing Pi "review" glyph until the Pi floor gets its own states.
  testing: "review",
  failing: "review",
  passing: "review",
  merged: "done",
  blocked: "blocked",
  cancelled: "cancelled",
};

export async function loadPlansIndexData(): Promise<PlanCardData[]> {
  const plans = await repo.listPlans();
  const progress = await repo.planProgressBatch(plans.map((p) => p.id));
  const tasks = await repo.listTasks();
  const groups = await loadRunsByGroup();
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

  const tasksByPlan = new Map<string, TaskFull[]>();
  for (const t of tasks) {
    const arr = tasksByPlan.get(t.planId) || [];
    arr.push(t);
    tasksByPlan.set(t.planId, arr);
  }

  // Match runs to a plan by id, not title: plan titles aren't unique, so filtering
  // by title double-counts runs across same-titled plans (each RunWithTask already
  // carries task.planId, which disambiguates).
  function runsForPlan(planId: string, bucket: RunWithTask[]): RunWithTask[] {
    return bucket.filter((g) => g.task?.planId === planId);
  }

  return plans.map((p) => {
    const prog = progress.get(p.id) ?? { done: 0, total: 0, pct: 0, open: 0 };
    const planTasks = tasksByPlan.get(p.id) || [];
    const queued = planTasks.filter((t) => t.state === "todo").length;
    const live = runsForPlan(p.id, groups.running);
    const review = runsForPlan(p.id, groups.review);
    const blocked = runsForPlan(p.id, groups.blocked);
    const shipped = runsForPlan(p.id, groups.shipped);
    const personas = Array.from(
      new Set(live.map((w) => w.run.personaId).filter(Boolean) as string[])
    );

    return {
      id: p.id,
      title: p.title,
      state: PLAN_STATE_TO_PI[p.state] ?? "todo",
      goal: extractFirstParagraph(p.body),
      owner: p.owner,
      done: prog.done,
      total: prog.total,
      liveRuns: live.length,
      reviewRuns: review.length,
      blockedRuns: blocked.length,
      queueCount: queued,
      shippedCount: shipped.length,
      activePersonas: personas,
    };
  });
}

function extractFirstParagraph(body: string): string {
  if (!body) return "";
  // Strip the first heading line, then take the first non-empty paragraph.
  const lines = body.split(/\r?\n/);
  let para: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      if (para.length) break;
      continue;
    }
    if (stripped.startsWith("#")) continue;
    para.push(stripped);
  }
  return para.join(" ").slice(0, 300);
}

export async function loadTasksIndexData(): Promise<{
  rows: TaskRowData[];
  plans: { id: string; title: string }[];
}> {
  const tasks = await repo.listTasks();
  const plans = await repo.listPlans();
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

  // Map taskId → most recent active/review/blocked run for quick "Open" jump.
  const allRuns = await runsLib.listRuns();
  const liveRunByTask = new Map<string, number>();
  for (const r of allRuns) {
    if (!r.taskId) continue;
    if (liveRunByTask.has(r.taskId)) continue;
    if (
      ACTIVE_STATUSES.has(r.status) ||
      REVIEW_STATUSES.has(r.status) ||
      BLOCKED_STATUSES.has(r.status)
    ) {
      liveRunByTask.set(r.taskId, r.id);
    }
  }

  const rows: TaskRowData[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    plan: planTitleById.get(t.planId) ?? null,
    planId: t.planId,
    state: TASK_STATE_TO_PI[t.state],
    runDbId: liveRunByTask.get(t.id) ?? null,
    prUrl: t.prUrl,
    persona: t.assignee,
    criteria: t.criteria.length
      ? { done: t.criteria.filter((c) => c.done).length, total: t.criteria.length }
      : null,
    tags: t.tags,
  }));

  return { rows, plans: plans.map((p) => ({ id: p.id, title: p.title })) };
}

export type PaletteItem = {
  kind: "Run" | "Task" | "Plan" | "Action";
  id: string;
  title: string;
  sub?: string;
  state?: string;
  href?: string;
};

export async function loadPaletteItems(): Promise<PaletteItem[]> {
  const plans = await repo.listPlans();
  const tasks = (await repo.listTasks()).slice(0, 40);
  const runs = (await runsLib.listRuns()).slice(0, 30);
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

  const planItems: PaletteItem[] = plans.map((p) => ({
    kind: "Plan",
    id: p.id,
    title: p.title,
    sub: p.owner ? `@${p.owner}` : "",
    state: PLAN_STATE_TO_PI[p.state],
    href: `/plans/${p.id}`,
  }));
  const taskItems: PaletteItem[] = tasks.map((t) => ({
    kind: "Task",
    id: t.id,
    title: t.title,
    sub: planTitleById.get(t.planId) || "",
    state: TASK_STATE_TO_PI[t.state],
    href: `/tasks/${t.id}`,
  }));
  const runItems: PaletteItem[] = runs.map((r) => ({
    kind: "Run",
    id: shortRunId(r.id, r.startedAt),
    title: r.title || `Run ${r.id}`,
    sub: r.personaId || r.model || "",
    state: ACTIVE_STATUSES.has(r.status)
      ? "in_progress"
      : REVIEW_STATUSES.has(r.status)
      ? "review"
      : BLOCKED_STATUSES.has(r.status)
      ? "blocked"
      : SHIPPED_STATUSES.has(r.status)
      ? "done"
      : "todo",
    href: `/runs/${r.id}`,
  }));

  return [...runItems, ...taskItems, ...planItems];
}
