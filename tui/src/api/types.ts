// Wire types. These mirror the server's response shapes exactly — field names
// and nullability are copied from lib/run-index.ts, lib/runs.ts, lib/types.ts
// and the route handlers under app/api. Keep them in sync by hand: the TUI is
// a REST client and deliberately does not import from lib/ (PRD §4 item 10).

/** lib/run-state.ts SESSION_STATUSES */
export type SessionStatus =
  | "pending"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "idle"
  | "budget_exhausted"
  | "closed"
  | "parked";

/** Why a parked run is parked. lib/run-state.ts ParkReason. */
export type ParkReason = "waiting" | "sleeping" | "question";

/** GET /api/runs/overview → { rows }. lib/run-index.ts RunIndexRow. */
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
  /** Per-run caps, as `/model` and `/budget` set them (T-tui-12). Null means
   *  the run inherits its persona / deployment default. */
  budgetMaxUsd: number | null;
  budgetMaxTurns: number | null;
  totalCostUsd: number | null;
  error: string | null;
  /** ISO-8601 */
  startedAt: string;
  /** ISO-8601 */
  completedAt: string | null;
  parkReason: string | null;
  pendingReason: string | null;
  /** Pending owner-audience inbox events queued for this run. */
  pendingEvents: number;
  /** Added for the cockpit: the persona driving the run. */
  personaId: string | null;
  personaName: string | null;
}

/** lib/sdk-message.ts SdkContentBlock */
export interface SdkContentBlock {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  /** Extended-thinking blocks: `thinking` carries the prose, `is_error` marks
   *  a tool_result the harness rejected. Both are drawn, so both are typed. */
  thinking?: string;
  is_error?: boolean;
  data?: string;
  mimeType?: string;
}

/** lib/runs.ts MessageRow, with Dates serialized to ISO strings. */
export interface MessageRow {
  id: number;
  runId: number;
  role: "user" | "agent" | "tool" | "system";
  content: SdkContentBlock[];
  /** ISO-8601 */
  createdAt: string;
}

/**
 * GET /api/runs/:id → the full RunRow plus messages and a process-local `live`
 * flag. Only the fields the cockpit reads are declared; the server sends more.
 */
export interface RunDetail {
  id: number;
  goal: string;
  status: SessionStatus;
  title: string | null;
  taskId: string | null;
  planId: string | null;
  parentRunId: number | null;
  personaId: string | null;
  prUrl: string | null;
  model: string | null;
  totalCostUsd: number | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  parkReason: string | null;
  budgetMaxUsd: number | null;
  budgetMaxTurns: number | null;
  messages: MessageRow[];
  live: boolean;
}

/** One frame off GET /api/runs/:id/events. Every frame is a bare `data:` line
 * carrying a JSON object with a `type` discriminator; agent events are spread
 * flat onto `{ type, ...payload }` by lib/run-stream.ts. */
export type RunStreamFrame =
  | { type: "message"; message: MessageRow }
  | { type: "_cursor"; cursor: StreamCursor }
  | { type: "_eos" }
  | ({ type: string } & Record<string, unknown>);

/** lib/run-stream.ts StreamCursor */
export interface StreamCursor {
  msgId: number;
  evtId: number;
}

export const ZERO_CURSOR: StreamCursor = { msgId: 0, evtId: 0 };

/** One frame off GET /api/runs/overview/events. */
export type OverviewFrame = { type: "rows"; rows: RunIndexRow[] } | { type: "_eos" };

/** One row of GET /api/runs/:id/inbox → events[]. */
export interface InboxEventRow {
  id: number;
  type: string;
  control: boolean;
  audience: string;
  status: string;
  sourceKind: string;
  sourceId: string | null;
  attempt: number | null;
  correlationId: string | null;
  causationEventId: number | null;
  bubbledFrom: number | null;
  payload: unknown;
  errorReason: string | null;
  runTurnId: number | null;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 */
  injectedAt: string | null;
}

/** One row of GET /api/runs/:id/inbox → timers[]. */
export interface RunTimerRow {
  id: number;
  status: string;
  note: string | null;
  correlationId: string | null;
  fireAt: string;
  createdAt: string;
  firedAt: string | null;
}

export interface RunInbox {
  events: InboxEventRow[];
  timers: RunTimerRow[];
}

/**
 * One row of GET /api/inbox?audience=owner — the cross-run needs-you list
 * (T-tui-04). Denormalised on the server so the cockpit renders it without a
 * second lookup per row.
 */
export interface GlobalInboxRow {
  /** Stable key: `e<eventId>` for an inbox event, `q<runId>` for a question. */
  id: string;
  runId: number;
  personaId: string | null;
  personaName: string | null;
  runTitle: string | null;
  kind: "question" | "review" | "stuck" | "budget";
  type: string;
  text: string;
  prUrl: string | null;
  /** ISO-8601 */
  createdAt: string;
}

/** GET /api/tasks → TaskFull[]. Only the palette-relevant fields. */
export interface TaskSummary {
  id: string;
  title: string;
  state: string;
  planId: string;
  prUrl: string | null;
}

/** GET /api/plans → PlanFull[]. Only the palette-relevant fields. */
export interface PlanSummary {
  id: string;
  title: string;
  state: string;
}

/**
 * POST /api/runs (201) and PATCH /api/runs/:id → the serialized run row.
 * A narrower view of the same row `RunDetail` widens with messages.
 */
export interface RunRow {
  id: number;
  goal: string;
  status: SessionStatus;
  title: string | null;
  personaId: string | null;
  parentRunId: number | null;
  model: string | null;
  budgetMaxUsd: number | null;
  budgetMaxTurns: number | null;
  taskId: string | null;
  planId: string | null;
  prUrl: string | null;
  totalCostUsd: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** Body for PATCH /api/runs/:id `{ action: "configure" }`. An omitted field is
 *  left alone; an explicit null clears the cap. */
export interface RunConfigInput {
  model?: string | null;
  budgetMaxUsd?: number | null;
  budgetMaxTurns?: number | null;
}

/** GET /api/personas → { personas }. The route also sends `systemPrompt`,
 * which the cockpit never shows. */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  toolsProfile: string | null;
  backend: string | null;
  budgetMaxTurns: number | null;
  budgetMaxSeconds: number | null;
}

/** Body for POST /api/runs. Mirrors createRunSchema in app/api/runs/route.ts. */
export interface CreateRunInput {
  goal: string;
  personaId?: string;
  model?: string | null;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh" | null;
  backend?: "pi" | "claude" | null;
  title?: string | null;
  taskId?: string | null;
  cwdStrategy?: "worktree" | "worktree_at_pr" | "repo" | "none";
  defer?: boolean;
  budget?: { maxTurns?: number; maxUsd?: number; maxSeconds?: number } | null;
}
