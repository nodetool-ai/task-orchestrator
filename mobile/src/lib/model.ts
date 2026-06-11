// View-model selectors. Pure functions that turn the raw REST payloads
// (sessions + tasks + plans) into the shapes the Pi Factory screens render.
// Bucketing mirrors the server's own Floor projection (lib/pi-floor-data.ts).

import type { AgentSession, PlanFull, SessionStatus, TaskFull } from "./types";
import { fauxSparkline, prNumber, shortRunId } from "./format";

const ACTIVE = new Set<SessionStatus>(["pending", "preparing", "running", "pushing"]);
const REVIEW = new Set<SessionStatus>(["opening_pr"]);
const BLOCKED = new Set<SessionStatus>(["failed", "budget_exhausted"]);
const SHIPPED = new Set<SessionStatus>(["completed"]);

export type RunSub = "editing" | "tool" | "thinking" | "starting";

function subFor(status: SessionStatus): RunSub {
  switch (status) {
    case "pending":
    case "preparing":
      return "starting";
    case "pushing":
      return "tool";
    default:
      return "editing";
  }
}

export interface TaskIndex {
  byId: Map<string, TaskFull>;
  planTitle: (planId: string | null | undefined) => string;
  progress: (taskId: string | null | undefined) => { done: number; total: number };
}

export function buildIndex(tasks: TaskFull[], plans: PlanFull[]): TaskIndex {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));
  return {
    byId,
    planTitle: (id) => (id ? planTitleById.get(id) ?? id : ""),
    progress: (taskId) => {
      const t = taskId ? byId.get(taskId) : null;
      if (!t) return { done: 0, total: 0 };
      return { done: t.criteria.filter((c) => c.done).length, total: t.criteria.length };
    },
  };
}

export interface FloorRunVM {
  runId: number;
  shortId: string;
  state: "in_progress" | "review" | "blocked";
  sub: RunSub;
  title: string;
  taskId: string | null;
  planTitle: string;
  model: string | null;
  branch: string | null;
  prNum: number | null;
  cost: number;
  budget: number;
  tokensIn: number;
  tokensOut: number;
  progress: { done: number; total: number };
  startedAt: number;
  reason: string | null;
  sparkline: number[];
}

function toFloorRun(
  s: AgentSession,
  state: FloorRunVM["state"],
  idx: TaskIndex
): FloorRunVM {
  const t = s.taskId ? idx.byId.get(s.taskId) : null;
  const startedAt = new Date(s.startedAt).getTime();
  let reason: string | null = null;
  if (state === "blocked") {
    reason =
      s.status === "budget_exhausted"
        ? `Budget exhausted ($${(s.totalCostUsd ?? 0).toFixed(2)})`
        : s.error || "Stopped per stop-rule";
  }
  return {
    runId: s.id,
    shortId: shortRunId(s.id, startedAt),
    state,
    sub: subFor(s.status),
    title: t?.title || `Run ${s.id}`,
    taskId: s.taskId,
    planTitle: idx.planTitle(t?.planId),
    model: s.model,
    branch: s.branch,
    prNum: prNumber(s.prUrl),
    cost: s.totalCostUsd ?? 0,
    budget: 25,
    tokensIn: s.inputTokens ?? 0,
    tokensOut: s.outputTokens ?? 0,
    progress: idx.progress(s.taskId),
    startedAt,
    reason,
    sparkline: fauxSparkline(s.id + Math.round((s.totalCostUsd ?? 1) * 10)),
  };
}

export interface ReviewVM {
  taskId: string;
  runId: number | null;
  title: string;
  planTitle: string;
  prNum: number | null;
  branch: string | null;
  model: string | null;
  cost: number;
}

export interface ShippedVM {
  runId: number;
  shortId: string;
  taskId: string;
  title: string;
  planTitle: string;
  prNum: number | null;
  cost: number;
}

export interface QueueVM {
  id: string;
  title: string;
  planId: string;
  planTitle: string;
  criteria: number;
  tags: string[];
  assignee: string | null;
}

export interface FloorData {
  running: FloorRunVM[];
  blocked: FloorRunVM[];
  review: ReviewVM[];
  shipped: ShippedVM[];
  queue: QueueVM[];
  costTotal: number;
  tokensIn: number;
  tokensOut: number;
}

export function buildFloor(
  sessions: AgentSession[],
  tasks: TaskFull[],
  plans: PlanFull[]
): FloorData {
  const idx = buildIndex(tasks, plans);

  // Latest session per task — used to enrich the review section.
  const latestByTask = new Map<string, AgentSession>();
  for (const s of sessions) {
    if (!s.taskId) continue;
    const prev = latestByTask.get(s.taskId);
    if (!prev || new Date(s.startedAt) > new Date(prev.startedAt)) latestByTask.set(s.taskId, s);
  }

  const byTime = (a: AgentSession, b: AgentSession) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();

  const running = sessions
    .filter((s) => ACTIVE.has(s.status))
    .sort(byTime)
    .map((s) => toFloorRun(s, "in_progress", idx));

  const blockedSessions = sessions
    .filter((s) => BLOCKED.has(s.status))
    .sort(byTime)
    .map((s) => toFloorRun(s, "blocked", idx));

  const review: ReviewVM[] = tasks
    .filter((t) => t.state === "review")
    .map((t) => {
      const s = latestByTask.get(t.id) || null;
      return {
        taskId: t.id,
        runId: s?.id ?? null,
        title: t.title,
        planTitle: idx.planTitle(t.planId),
        prNum: prNumber(s?.prUrl),
        branch: s?.branch ?? null,
        model: s?.model ?? null,
        cost: s?.totalCostUsd ?? 0,
      };
    });

  const shipped: ShippedVM[] = sessions
    .filter((s) => SHIPPED.has(s.status))
    .sort(byTime)
    .map((s) => {
      const t = s.taskId ? idx.byId.get(s.taskId) : null;
      return {
        runId: s.id,
        shortId: shortRunId(s.id, new Date(s.startedAt).getTime()),
        taskId: s.taskId,
        title: t?.title || `Run ${s.id}`,
        planTitle: idx.planTitle(t?.planId),
        prNum: prNumber(s.prUrl),
        cost: s.totalCostUsd ?? 0,
      };
    });

  const queue: QueueVM[] = tasks
    .filter((t) => t.state === "todo")
    .map((t) => ({
      id: t.id,
      title: t.title,
      planId: t.planId,
      planTitle: idx.planTitle(t.planId),
      criteria: t.criteria.length,
      tags: t.tags,
      assignee: t.assignee,
    }));

  const costTotal = sessions.reduce((a, s) => a + (s.totalCostUsd ?? 0), 0);
  const tokensIn = sessions.reduce((a, s) => a + (s.inputTokens ?? 0), 0);
  const tokensOut = sessions.reduce((a, s) => a + (s.outputTokens ?? 0), 0);

  return { running, blocked: blockedSessions, review, shipped, queue, costTotal, tokensIn, tokensOut };
}

export interface PlanCardVM {
  id: string;
  title: string;
  state: PlanFull["state"];
  owner: string | null;
  goal: string;
  done: number;
  total: number;
}

export function buildPlanCards(plans: PlanFull[], tasks: TaskFull[]): PlanCardVM[] {
  const counts = new Map<string, { done: number; total: number }>();
  for (const t of tasks) {
    if (t.state === "cancelled") continue;
    const c = counts.get(t.planId) || { done: 0, total: 0 };
    c.total += 1;
    if (t.state === "done") c.done += 1;
    counts.set(t.planId, c);
  }
  return plans.map((p) => {
    const c = counts.get(p.id) || { done: 0, total: 0 };
    return {
      id: p.id,
      title: p.title,
      state: p.state,
      owner: p.owner,
      goal: firstLine(p.body),
      done: c.done,
      total: c.total,
    };
  });
}

function firstLine(body: string): string {
  if (!body) return "";
  const cleaned = body
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "")
    .trim();
  const para = cleaned.split(/\n\s*\n/)[0] || cleaned;
  return para.replace(/\n/g, " ").slice(0, 200);
}

// Map a plan state to the run-state palette key used by glyphs.
export function planGlyphState(state: PlanFull["state"]): "todo" | "in_progress" | "done" | "cancelled" {
  if (state === "done") return "done";
  if (state === "cancelled") return "cancelled";
  if (state === "accepted" || state === "proposed") return "in_progress";
  return "todo";
}
