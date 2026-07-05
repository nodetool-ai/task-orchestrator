// Client-safe helpers for the unified /runs index.
//
// Every chat IS a run (goal '<chat>' in agent_runs), and runs may spawn child
// runs (parent_run_id). The /runs page renders them all in one place: a forest
// of run trees, grouped by the most-active status found anywhere in each tree
// so a dormant parent with a live child still surfaces under Active.
//
// No db/node imports here — components/runs/runs-index.tsx (a client
// component) builds and filters the forest from rows it polls over JSON.

import type { SessionStatus } from "./types";

// ──────────────────────────────────────────────────────────
// Status → group (Active / Idle / Closed)
// ──────────────────────────────────────────────────────────

export type RunGroup = "active" | "idle" | "closed";

const ACTIVE_STATUSES = new Set<string>([
  "preparing",
  "running",
  "pushing",
  "opening_pr",
]);
const IDLE_STATUSES = new Set<string>(["pending", "idle"]);
const CLOSED_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "closed",
  "budget_exhausted",
]);

export function groupForStatus(status: string): RunGroup {
  if (ACTIVE_STATUSES.has(status)) return "active";
  if (IDLE_STATUSES.has(status)) return "idle";
  if (CLOSED_STATUSES.has(status)) return "closed";
  // Unknown statuses fall into Idle so they're still discoverable rather
  // than silently dropped.
  return "idle";
}

export const RUN_GROUPS: readonly RunGroup[] = ["active", "idle", "closed"] as const;

export const RUN_GROUP_LABEL: Record<RunGroup, string> = {
  active: "Active",
  idle: "Idle",
  closed: "Closed",
};

const GROUP_PRIORITY: Record<RunGroup, number> = { active: 0, idle: 1, closed: 2 };

// ──────────────────────────────────────────────────────────
// Row shape + forest building
// ──────────────────────────────────────────────────────────

/** A run serialized for the /runs index. Dates are ISO strings so the same
 *  shape survives the JSON hop through GET /api/runs/overview. */
export interface RunIndexRow {
  id: number;
  goal: string;
  status: SessionStatus;
  origin: "task" | "chat";
  title: string | null;
  taskId: string | null;
  taskTitle: string | null;
  planId: string | null;
  planTitle: string | null;
  repoId: string | null;
  repoName: string | null;
  parentRunId: number | null;
  prUrl: string | null;
  model: string | null;
  totalCostUsd: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Why a 'parked' run is parked ('waiting'|'sleeping'|'question'), or null. */
  parkReason: string | null;
  /** Pending owner-audience inbox events queued for this run (will wake it). */
  pendingEvents: number;
}

export interface RunTreeNode {
  run: RunIndexRow;
  children: RunTreeNode[];
}

/**
 * Assemble rows into parent/child trees. A row whose parentRunId is null or
 * points at a run not in `rows` (parent_run_id carries no FK, so parents can
 * be deleted out from under children) becomes a root. Children sort by id
 * (spawn order); roots keep the caller's order (startedAt desc from the DB).
 * A cyclic parent graph (nothing enforces acyclicity at the DB level) is
 * recovered by promoting the lowest-id member of each unreachable cycle to a
 * root, so no run ever silently disappears from the page.
 */
export function buildRunForest(rows: RunIndexRow[]): RunTreeNode[] {
  const nodes = new Map<number, RunTreeNode>();
  for (const r of rows) nodes.set(r.id, { run: r, children: [] });

  const roots: RunTreeNode[] = [];
  for (const r of rows) {
    const node = nodes.get(r.id)!;
    const parent =
      r.parentRunId != null && r.parentRunId !== r.id ? nodes.get(r.parentRunId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Mark everything reachable from a root; whatever remains is part of a
  // parent cycle. Promote one member per cycle until all nodes are reachable.
  const reachable = new Set<number>();
  const mark = (n: RunTreeNode) => {
    if (reachable.has(n.run.id)) return;
    reachable.add(n.run.id);
    for (const c of n.children) mark(c);
  };
  for (const root of roots) mark(root);
  for (const r of rows) {
    if (reachable.has(r.id)) continue;
    const node = nodes.get(r.id)!;
    const parent = nodes.get(r.parentRunId!);
    if (parent) parent.children = parent.children.filter((c) => c !== node);
    roots.push(node);
    mark(node);
  }

  for (const n of nodes.values()) n.children.sort((a, b) => a.run.id - b.run.id);
  return roots;
}

/** The most-active group anywhere in the tree — a finished parent whose
 *  children are still running belongs under Active. */
export function groupForTree(node: RunTreeNode): RunGroup {
  let best = groupForStatus(node.run.status);
  for (const c of node.children) {
    const g = groupForTree(c);
    if (GROUP_PRIORITY[g] < GROUP_PRIORITY[best]) best = g;
  }
  return best;
}

/** Latest startedAt (ms) anywhere in the tree, for recency sorting: a stale
 *  parent bubbles up when it spawns a fresh child. */
export function latestActivity(node: RunTreeNode): number {
  let latest = Date.parse(node.run.startedAt) || 0;
  for (const c of node.children) latest = Math.max(latest, latestActivity(c));
  return latest;
}

/** Total number of runs in the tree, the root included. */
export function treeSize(node: RunTreeNode): number {
  let n = 1;
  for (const c of node.children) n += treeSize(c);
  return n;
}

// ──────────────────────────────────────────────────────────
// Kind + filtering
// ──────────────────────────────────────────────────────────

/** Chat runs vs everything else (implement/review/execute/ad-hoc). */
export type RunKind = "chat" | "agent";

export function kindForRun(run: Pick<RunIndexRow, "goal">): RunKind {
  return run.goal === "<chat>" ? "chat" : "agent";
}

export interface RunForestFilter {
  /** Root kind; children of any kind stay visible under a matching root. */
  kind?: RunKind | null;
  /** Keep trees where ANY member ran against this repo. */
  repoId?: string | null;
  /** Keep trees where ANY member belongs to this task. */
  taskId?: string | null;
}

function treeHas(node: RunTreeNode, pred: (r: RunIndexRow) => boolean): boolean {
  if (pred(node.run)) return true;
  return node.children.some((c) => treeHas(c, pred));
}

/** Trees are kept or dropped whole — a filtered view still shows the full
 *  parent/child context of every match. */
export function filterForest(forest: RunTreeNode[], f: RunForestFilter): RunTreeNode[] {
  return forest.filter((t) => {
    if (f.kind && kindForRun(t.run) !== f.kind) return false;
    if (f.repoId && !treeHas(t, (r) => r.repoId === f.repoId)) return false;
    if (f.taskId && !treeHas(t, (r) => r.taskId === f.taskId)) return false;
    return true;
  });
}

// ──────────────────────────────────────────────────────────
// Display helpers
// ──────────────────────────────────────────────────────────

export function runHeading(run: RunIndexRow): string {
  if (run.goal === "<chat>") return run.title ?? `Chat #${run.id}`;
  if (run.goal === "<execute>") {
    return run.planTitle ? `Execute: ${run.planTitle}` : run.title ?? `Execute #${run.id}`;
  }
  if (run.taskTitle) return run.taskTitle;
  if (run.title) return run.title;
  if (run.taskId) return run.taskId;
  // Free-form goals ('summarize the failures', …) are their own best label.
  if (run.goal && !run.goal.startsWith("<")) return run.goal;
  return `Run #${run.id}`;
}

/** Small mono tag naming the run's role, for goals whose heading alone doesn't
 *  say what the run does (a review child otherwise reads like its task). */
export function runGoalTag(run: Pick<RunIndexRow, "goal">): string | null {
  switch (run.goal) {
    case "<review>":
      return "review";
    case "<execute>":
      return "execute";
    case "<plan>":
      return "plan";
    default:
      return null;
  }
}
