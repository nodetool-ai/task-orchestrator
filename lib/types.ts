export const TASK_STATES = [
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const PLAN_STATES = ["draft", "proposed", "accepted", "done", "cancelled"] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const TASK_BOARD_STATES = ["todo", "in_progress", "review", "blocked", "done"] as const;

export const STATE_LABEL: Record<TaskState | PlanState, string> = {
  todo: "Todo",
  in_progress: "In progress",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
  draft: "Draft",
  proposed: "Proposed",
  accepted: "Accepted",
};

export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  todo: ["in_progress", "cancelled"],
  in_progress: ["review", "done", "blocked", "cancelled"],
  review: ["in_progress", "done", "cancelled"],
  blocked: ["in_progress", "cancelled"],
  done: [],
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
  /** PR url of the task's most recent agent run that opened one, for display
   *  (null if no run has opened a PR yet). A task can span several runs/PRs;
   *  this is the latest. */
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
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface AgentSessionFull {
  id: number;
  taskId: string;
  status: SessionStatus;
  model: string | null;
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
