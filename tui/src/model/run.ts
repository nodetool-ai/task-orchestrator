// One floor row, derived from the overview payload. Field names track
// tui/src/data.ts so rewiring the views is mechanical.

import type { RunIndexRow } from "../api/types.js";
import { toTuiStatus, type TuiStatus } from "./status.js";

export interface Run {
  id: number;
  parentId: number | null;
  persona: string;
  title: string;
  status: TuiStatus;
  taskId: string | null;
  planId: string | null;
  pr: { number: number; ci: "pending" | "pass" | "fail" | "unknown" } | null;
  /** The raw PR link, kept alongside the parsed number because `o` opens a
   *  url the cockpit cannot always parse a number out of. */
  prUrl: string | null;
  /** What `/model` and `/budget` set; null means the run inherits. */
  model: string | null;
  budgetUsd: number | null;
  budgetTurns: number | null;
  startedAt: number;
  completedAt: number | null;
  cost: number;
  pendingEvents: number;
  error: string | null;
}

export function toRun(row: RunIndexRow): Run {
  const pr = prNumber(row.prUrl);
  return {
    id: row.id,
    parentId: row.parentRunId,
    persona: row.personaName ?? row.personaId ?? "agent",
    title: oneLine(row.title ?? row.taskTitle ?? row.goal),
    status: toTuiStatus(row.status, row.parkReason),
    taskId: row.taskId,
    planId: row.planId,
    // The overview payload carries no check-run state, so CI is unknown until
    // the row is opened. Fill this in when /api/runs/overview grows a ci field.
    pr: pr === null ? null : { number: pr, ci: "unknown" },
    prUrl: row.prUrl,
    model: row.model,
    budgetUsd: row.budgetMaxUsd,
    budgetTurns: row.budgetMaxTurns,
    startedAt: epoch(row.startedAt),
    completedAt: row.completedAt === null ? null : epoch(row.completedAt),
    cost: row.totalCostUsd ?? 0,
    pendingEvents: row.pendingEvents,
    error: row.error,
  };
}

const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pulls?\/(\d+)(?:$|[/?#])/i;

/** The PR number out of a GitHub PR url, tolerating `/files`, trailing
 *  slashes and query strings. Anything else (including a bare number or a
 *  non-GitHub url) is not a PR we can link to → null. */
export function prNumber(prUrl: string | null): number | null {
  if (!prUrl) return null;
  const m = PR_URL.exec(prUrl.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function oneLine(s: string): string {
  const first = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/\s+/g, " ").trim();
}

function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
