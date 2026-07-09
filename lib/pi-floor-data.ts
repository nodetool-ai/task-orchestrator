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
  run: runsLib.TaskRunSummary;
  task: TaskFull | null;
  planTitle: string | null;
};

async function loadRunsByGroup(): Promise<{
  running: RunWithTask[];
  review: RunWithTask[];
  blocked: RunWithTask[];
  shipped: RunWithTask[];
}> {
  // One lean run query plus batched task/plan-title hydration. The previous
  // per-run getTask()/getPlan() loop issued ~6 sequential queries per distinct
  // task, which dominated the floor and plans-index load time.
  const allRuns = await runsLib.listTaskRunSummaries();
  const taskIds = Array.from(new Set(allRuns.map((r) => r.taskId)));
  const taskById = new Map((await repo.listTasks({ ids: taskIds })).map((t) => [t.id, t]));
  const planIds = Array.from(new Set(Array.from(taskById.values(), (t) => t.planId)));
  const planTitleById = await repo.planTitlesByIds(planIds);

  const groups = { running: [] as RunWithTask[], review: [] as RunWithTask[], blocked: [] as RunWithTask[], shipped: [] as RunWithTask[] };
  for (const run of allRuns) {
    const task = taskById.get(run.taskId) ?? null;
    const planTitle = task ? planTitleById.get(task.planId) ?? null : null;
    const wrapped = { run, task, planTitle };
    const cat = classifyRun(run.status, run.prUrl, task?.state);
    if (cat === "running") groups.running.push(wrapped);
    else if (cat === "review") groups.review.push(wrapped);
    else if (cat === "blocked") groups.blocked.push(wrapped);
    else if (cat === "shipped") groups.shipped.push(wrapped);
  }
  // Return the full shipped list (ordered most-recent-first). Callers that
  // render the floor's shipped table truncate to the 8 newest themselves;
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
  const [groups, allTodoTasks, plans] = await Promise.all([
    loadRunsByGroup(),
    repo.listTasks({ state: "todo" }),
    repo.listPlans(),
  ]);
  const todoTasks = allTodoTasks.slice(0, 12);
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
  const [plans, taskSummaries, groups] = await Promise.all([
    repo.listPlans(),
    repo.listTaskSummaries(),
    loadRunsByGroup(),
  ]);

  // Per-plan progress and queue counts from the lean task projection — the
  // cards only need counts, not fully hydrated tasks. Same rules as
  // repo.planProgress: cancelled tasks don't count, merged is the sole
  // success terminal.
  const progress = new Map<string, { done: number; total: number }>();
  for (const p of plans) progress.set(p.id, { done: 0, total: 0 });
  const queuedByPlan = new Map<string, number>();
  for (const t of taskSummaries) {
    if (t.state === "todo") queuedByPlan.set(t.planId, (queuedByPlan.get(t.planId) ?? 0) + 1);
    if (t.state === "cancelled") continue;
    const prog = progress.get(t.planId);
    if (!prog) continue;
    prog.total += 1;
    if (t.state === "merged") prog.done += 1;
  }

  // Match runs to a plan by id, not title: plan titles aren't unique, so keying
  // by title double-counts runs across same-titled plans (each RunWithTask
  // already carries task.planId, which disambiguates).
  function countsByPlan(bucket: RunWithTask[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const g of bucket) {
      const pid = g.task?.planId;
      if (pid) m.set(pid, (m.get(pid) ?? 0) + 1);
    }
    return m;
  }
  const liveByPlan = countsByPlan(groups.running);
  const reviewByPlan = countsByPlan(groups.review);
  const blockedByPlan = countsByPlan(groups.blocked);
  const shippedByPlan = countsByPlan(groups.shipped);
  const personasByPlan = new Map<string, Set<string>>();
  for (const g of groups.running) {
    const pid = g.task?.planId;
    if (!pid || !g.run.personaId) continue;
    const set = personasByPlan.get(pid) ?? new Set<string>();
    set.add(g.run.personaId);
    personasByPlan.set(pid, set);
  }

  return plans.map((p) => {
    const prog = progress.get(p.id)!;
    return {
      id: p.id,
      title: p.title,
      state: PLAN_STATE_TO_PI[p.state] ?? "todo",
      goal: extractFirstParagraph(p.body),
      owner: p.owner,
      done: prog.done,
      total: prog.total,
      liveRuns: liveByPlan.get(p.id) ?? 0,
      reviewRuns: reviewByPlan.get(p.id) ?? 0,
      blockedRuns: blockedByPlan.get(p.id) ?? 0,
      queueCount: queuedByPlan.get(p.id) ?? 0,
      shippedCount: shippedByPlan.get(p.id) ?? 0,
      activePersonas: Array.from(personasByPlan.get(p.id) ?? []),
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
  const [tasks, plans, allRuns] = await Promise.all([
    repo.listTasks(),
    repo.listPlans(),
    // Map taskId → most recent active/review/blocked run for quick "Open" jump.
    runsLib.listTaskRunSummaries(),
  ]);
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));

  const liveRunByTask = new Map<string, number>();
  for (const r of allRuns) {
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
  // Lean loads: the palette renders on every page (layout), so it must not
  // hydrate full tasks or drag every run row along.
  const [plans, taskSummaries, runs] = await Promise.all([
    repo.listPlans(),
    repo.listTaskSummaries(),
    runsLib.listRuns({ limit: 30 }),
  ]);
  const tasks = taskSummaries.slice(0, 40);
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
