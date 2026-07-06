import type { CwdStrategy } from "./runs";

export const TASK_STATES = [
  "todo",
  "in_progress",
  "testing",
  "failing",
  "passing",
  "merged",
  "blocked",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PLAN_STATES = ["draft", "proposed", "accepted", "done", "cancelled"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const TASK_BOARD_STATES = [
  "todo",
  "in_progress",
  "testing",
  "failing",
  "passing",
  "blocked",
] as const;

export const STATE_LABEL: Record<TaskState | PlanState, string> = {
  todo: "Todo",
  in_progress: "In progress",
  testing: "Testing",
  failing: "Failing",
  passing: "Passing",
  merged: "Merged",
  blocked: "Blocked",
  cancelled: "Cancelled",
  // Plan states (draft/proposed/accepted/done/cancelled). `done` is a PLAN
  // terminal — tasks no longer use it; do not remove.
  draft: "Draft",
  proposed: "Proposed",
  accepted: "Accepted",
  done: "Done",
};

// A merged PR is authoritative and GitHub CI can flip between pass/fail at any
// time, so every non-terminal PR-backed state must accept ALL states the GitHub
// sync can derive ({testing, failing, passing, blocked, merged} — see
// prToTaskState). Otherwise applyTaskStateFromPr / transitionTask hit an illegal
// edge and silently no-op, stranding a task forever (e.g. a PR merged while a
// non-required check is red would never move `failing` → `merged`). `todo` is
// the only exception: it has no PR yet, so it just advances to in_progress.
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["testing", "failing", "passing", "merged", "blocked", "cancelled"],
  testing: ["passing", "failing", "merged", "blocked", "cancelled"],
  failing: ["testing", "passing", "merged", "blocked", "cancelled"],
  passing: ["merged", "testing", "failing", "blocked", "cancelled"],
  blocked: ["in_progress", "testing", "failing", "passing", "merged", "cancelled"],
  merged: [],
  cancelled: [],
};

export const PLAN_TRANSITIONS: Record<PlanState, PlanState[]> = {
  draft: ["proposed", "accepted", "cancelled"],
  proposed: ["accepted", "cancelled"],
  accepted: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export const PLANNING_STAGES = [
  "gathering",
  "spec_review",
  "building_plan",
  "plan_review",
  "committing",
  "done",
] as const;
export type PlanningStage = (typeof PLANNING_STAGES)[number];

export const PLANNING_STAGE_TRANSITIONS: Record<PlanningStage, PlanningStage[]> = {
  gathering: ["spec_review"],
  spec_review: ["building_plan"],
  building_plan: ["plan_review"],
  plan_review: ["committing"],
  committing: ["done"],
  done: [],
};

export type AttachmentKind = "image" | "artifact";

/**
 * Attachment metadata — the bytes (the `content` BLOB) are never included
 * here. Fetch them via the download route or the get_attachment tool. Carried
 * on TaskFull/PlanFull so the dashboard, agent prompts, and MCP callers all
 * see the same attachment roster.
 */
export interface AttachmentMeta {
  id: number;
  planId: string | null;
  taskId: string | null;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  author: string;
  createdAt: Date;
}

export interface TaskFull {
  id: string;
  title: string;
  state: TaskState;
  planId: string;
  assignee: string | null;
  body: string;
  estimate: string | null;
  tags: string[];
  repoId: string | null;
  /** The task's PR link. Authoritative once set explicitly via the
   *  set_task_pr tool (persisted on tasks.pr_url); until then, falls back to
   *  the most recent agent run that opened one. Null if neither exists. */
  prUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  dependencies: string[];
  notes: Array<{ id: number; author: string; body: string; createdAt: Date }>;
  criteria: Array<{ id: number; text: string; done: boolean; position: number }>;
  attachments: AttachmentMeta[];
}

export interface PlanFull {
  id: string;
  title: string;
  state: PlanState;
  owner: string | null;
  body: string;
  tags: string[];
  /** Repositories attached to this plan, ordered by position. */
  repos: RepositoryRow[];
  createdAt: Date;
  updatedAt: Date;
  attachments: AttachmentMeta[];
}

export interface RepositoryRow {
  id: string;
  name: string;
  remote: string | null;
  localPath: string | null;
  defaultBranch: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanProgress {
  total: number;
  done: number;
  pct: number;
  open: number;
}

export const SESSION_STATUSES = [
  "pending",
  "preparing",
  "running",
  "pushing",
  "opening_pr",
  "completed",
  "failed",
  "cancelled",
  // v2 (lib/runs.ts): chat-style runs sit `idle` between turns and resume
  // back into `running` when a new message is appended. `budget_exhausted`
  // is a soft stop when a configured budget is hit; `closed` is the user
  // archiving an idle run.
  "idle",
  "budget_exhausted",
  "closed",
  // Event system (docs/agent-events.md §6.1): the run ended its turn waiting
  // for inbox events — no worker, no heartbeat, woken by emitInboxEvent /
  // the pump wake sweep. The nuance ('waiting' | 'sleeping' | 'question')
  // lives in agent_runs.park_reason; the status machinery sees one state.
  // NOT terminal: like `idle`, a parked run resumes.
  "parked",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Statuses that mean "a turn is in flight" — the only ones a heartbeat lease
 *  covers. 'parked' (like 'idle') is deliberately NOT a lease status: a parked
 *  run has no worker and no heartbeat and that is HEALTHY (§6.1). Single
 *  source of truth for runs.ts (lease/orphan logic) and the worker transport
 *  (claim-release guard) — the two must never drift, or a claim release could
 *  clear a healthy worker's claim mid-turn. */
export const LEASE_STATUSES: SessionStatus[] = ["running", "preparing", "pushing", "opening_pr"];

export interface AgentSessionFull {
  id: number;
  taskId: string;
  status: SessionStatus;
  model: string | null;
  /** Agent backend ('pi'|'claude'), or null = deployment default. */
  backend: "pi" | "claude" | null;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  error: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sdkSessionId: string | null;
  resumeOf: number | null;
  repoId: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface AgentEventRow {
  id: number;
  sessionId: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export function isTerminalStatus(s: SessionStatus): boolean {
  // 'idle' is intentionally NOT terminal: an idle run is waiting for the
  // next user message and can be resumed. 'closed' / 'budget_exhausted' are
  // terminal; the user must explicitly fork or extend the budget to revive.
  return (
    s === "completed" ||
    s === "failed" ||
    s === "cancelled" ||
    s === "closed" ||
    s === "budget_exhausted"
  );
}

export type ChatRole = "user" | "assistant" | "tool_result";

export interface ChatRow {
  id: number;
  userId: number | null;
  title: string;
  cwdStrategy: CwdStrategy;
  model: string | null;
  sdkSessionId: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  repoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessageRow {
  id: number;
  chatId: number;
  role: ChatRole;
  // Stored as JSON-encoded SdkContentBlock[]. Imported as `unknown[]` here to
  // avoid a circular dep on sdk-message; consumers cast as needed.
  content: unknown[];
  createdAt: Date;
}

export interface ChatStreamEvent {
  type: "user_message" | "sdk" | "done" | "error";
  message?: ChatMessageRow;
  sdk?: unknown;
  error?: string;
}
