// API response shapes — mirror the serialized JSON from the Next.js backend
// (lib/types.ts on the server). Dates come over the wire as ISO strings.

export type SessionStatus =
  | "pending"
  | "preparing"
  | "running"
  | "pushing"
  | "opening_pr"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle"
  | "budget_exhausted"
  | "closed";

// Mirrors the server's TASK_STATES (lib/types.ts). PR-backed tasks flow through
// testing/failing/passing/merged as CI reports in — see lib/task-state.ts.
export type TaskState =
  | "todo"
  | "in_progress"
  | "testing"
  | "failing"
  | "passing"
  | "merged"
  | "blocked"
  | "cancelled";

export type PlanState = "draft" | "proposed" | "accepted" | "done" | "cancelled";

// Agent execution backend (a.k.a. "engine"). Matches the server's
// lib/agent-backend BACKEND_IDS. Runs may pick one at spawn/resume time.
export type BackendId = "pi" | "claude";

// /api/providers → catalog of backends + their providers, plus the
// deployment default a run with no explicit pick executes on.
export interface ProvidersResponse {
  providers: unknown[];
  backends: { id: BackendId; providers: unknown[] }[];
  defaultBackend: BackendId;
}

// Planning-agent lifecycle stages. `spec_review` / `plan_review` are the two
// gates that wait on a human before the run proceeds.
export type PlanningStage =
  | "gathering"
  | "spec_review"
  | "building_plan"
  | "plan_review"
  | "committing"
  | "done";

export interface Criterion {
  id: number;
  text: string;
  done: boolean;
  position: number;
}

export interface TaskNote {
  id: number;
  author: string;
  body: string;
  createdAt: string;
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
  createdAt: string;
  updatedAt: string;
  dependencies: string[];
  notes: TaskNote[];
  criteria: Criterion[];
  attachments: unknown[];
}

export interface PlanFull {
  id: string;
  title: string;
  state: PlanState;
  owner: string | null;
  body: string;
  tags: string[];
  repos: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
  attachments: unknown[];
}

export interface PlanProgress {
  total: number;
  done: number;
  pct: number;
  open: number;
}

export interface PlanDetail extends PlanFull {
  progress: PlanProgress;
  tasks: TaskFull[];
}

// /api/sessions  → AgentSessionFull[]
export interface AgentSession {
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
  startedAt: string;
  completedAt: string | null;
}

// /api/personas → { personas: Persona[] }
export interface Persona {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  thinkingLevel: string | null;
  toolsProfile: string;
  budgetMaxTurns: number | null;
  budgetMaxSeconds: number | null;
}

// /api/runs/[id] → RunRow + messages + live
export interface MessageRow {
  id: number;
  runId: number;
  role: "user" | "agent" | "tool" | "system";
  content: unknown[];
  createdAt: string;
}

export interface RunDetail {
  id: number;
  goal: string;
  status: SessionStatus;
  origin: "task" | "chat";
  taskId: string | null;
  planId: string | null;
  repoId: string | null;
  model: string | null;
  branch: string | null;
  prUrl: string | null;
  error: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  budgetMaxUsd: number | null;
  title: string | null;
  personaId: string | null;
  planningStage: PlanningStage | null;
  startedAt: string;
  completedAt: string | null;
  messages: MessageRow[];
  live: boolean;
}

// /api/live-sessions → { items: LiveSessionItem[] }
export interface LiveSessionItem {
  runDbId: number;
  shortId: string;
  bucket: "running" | "review" | "blocked";
  title: string;
  taskId: string | null;
  branch: string | null;
  prNum: number | null;
  persona: string | null;
  cost: number;
  startedAt: number;
  reason: string | null;
}
