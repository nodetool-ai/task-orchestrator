// lib/worker/protocol.ts
//
// RunTransport: the typed control-plane persistence interface for run state.
// The only implementation is db-transport (direct Postgres): the web server /
// CLI / tests ARE the orchestrator and read/write directly through it.
// Dispatched workers never construct a transport — they run over the WebSocket
// channel (lib/worker-channel), whose control-plane handlers persist through the
// same db-transport, so persistence semantics live in exactly one place.
//
// This module also carries the shared worker-domain types (row shapes, status
// guards) used by both the transport and the channel handlers.
//
// Design notes:
//   • pollCancel() is the cross-process cancel poll (no liveness write).
//   • subscribeInput() abstracts "a new user message arrived" (Postgres LISTEN
//     'run_input').
//   • applyStatus() carries the CAS guard by NAME (WireStatusGuard), because a
//     drizzle SQL fragment can't cross a process boundary. The two named
//     guards are the only ones worker code paths use.
//   • releaseClaim() is a single high-level op (release + stranded-message
//     check + conditional re-dispatch).

import type { MessageRow, RunRow } from "../runs";
import type { SdkContentBlock } from "../sdk-message";
import type { PlanFull, RepositoryRow, SessionStatus, TaskFull, TaskState } from "../types";

/** The personas table row shape repo.getPersona returns (NOT the code-defined
 *  lib/personas Persona — DB personas carry nullable/denormalized fields). */
export interface PersonaRecord {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string;
  toolsProfile: string;
  budgetMaxTurns: number | null;
  budgetMaxSeconds: number | null;
  skillPaths: string;
  createdAt: Date;
  updatedAt: Date;
}

// ── status writes ───────────────────────────────────────────────────────────

/** Named CAS guards for applyStatus — the wire form of the drizzle guards the
 *  worker paths use. `none` = unconditional (row-exists only). */
export type WireStatusGuard = "none" | "not-terminal" | "not-cancelled-closed";

/** Extra columns a status landing may write alongside `status`. All optional;
 *  `completedAt` travels as ISO-8601 over the wire. */
export interface StatusSet {
  sdkSessionId?: string | null;
  totalCostUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  outcome?: string | null;
  prUrl?: string | null;
  parkReason?: string | null;
  result?: unknown | null;
  error?: string | null;
  completedAt?: Date | string | null;
}

export interface ApplyStatusOpts {
  set?: StatusSet;
  guard?: WireStatusGuard;
  /** Extra fields folded into the paired status event payload (e.g. { error }). */
  extra?: Record<string, unknown>;
  /** Retry the write on transient failures this many times (worker exit paths). */
  retries?: number;
}

// ── run patches ─────────────────────────────────────────────────────────────

/** Whitelisted non-status column writes worker code performs mid-turn. */
export interface RunPatch {
  sdkSessionId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  repoId?: string | null;
  prUrl?: string | null;
  result?: unknown | null;
  parkReason?: string | null;
  planningStage?: string | null;
  completedAt?: Date | string | null;
  /** attempt = attempt + 1 (fresh rework turn on a resumed terminal run). */
  incrementAttempt?: boolean;
}

export interface TaskTransitionInput {
  state: TaskState;
  assignee?: string;
  note?: string;
}

export interface CancelPollResult {
  /** True when a cross-process cancel was requested; the worker must abort its turn. */
  cancelRequested: boolean;
}

export interface ReleaseClaimOpts {
  lastProcessedUserMsgId: number;
  /** Chat-loop exit: land the run `idle` (resumable) when it isn't terminal,
   *  BEFORE the stranded-message re-dispatch check. */
  idleIfNonTerminal?: boolean;
}

export interface AppendMessageOpts {
  /** Makes worker HTTP retries safe after ambiguous timeout/network failures. */
  idempotencyKey?: string;
}

/** Result content an orchestrator tool returns (mirrors lib/orchestrator-tools). */
export interface ToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

export interface ToolCallContext {
  author: string;
  defaultTaskId?: string;
  defaultPlanId?: string;
}

export type MessageRole = MessageRow["role"];

// ── the transport ───────────────────────────────────────────────────────────

export interface RunTransport {
  readonly kind: "db" | "http";

  // run plane
  getRun(runId: number): Promise<RunRow | null>;
  listMessages(runId: number): Promise<MessageRow[]>;
  appendMessage(
    runId: number,
    role: MessageRole,
    content: SdkContentBlock[],
    opts?: AppendMessageOpts
  ): Promise<MessageRow>;
  /** Append a raw agent_events row (turn_done markers, non-terminal status mirrors). */
  appendEvent(runId: number, type: string, payload: Record<string, unknown>): Promise<void>;
  /** Count a run's events of one type (chat resume bookkeeping). */
  countEvents(runId: number, type: string): Promise<number>;
  /**
   * Guarded, atomic status landing: status column + paired status event as one
   * transaction, CAS'd by the named guard. Returns true iff the row was written.
   * Terminal landings also fire the child-lifecycle inbox event (server-side).
   * Does NOT touch the caller's in-process live bus — that stays with the caller.
   */
  applyStatus(runId: number, status: SessionStatus, opts?: ApplyStatusOpts): Promise<boolean>;
  /** Non-terminal status write with a best-effort event mirror (the historical
   *  setStatus semantics). Terminal statuses route through applyStatus internally. */
  setStatus(runId: number, status: SessionStatus): Promise<void>;
  patchRun(runId: number, patch: RunPatch): Promise<void>;

  // liveness + control plane
  /** Cross-process cancel poll: the worker learns `cancel_requested` flips here. */
  pollCancel(runId: number): Promise<CancelPollResult>;
  /** Acknowledge the run.cancel_requested control event after aborting. */
  ackCancel(runId: number): Promise<void>;
  /**
   * End-of-worker release: clear the worker claim (guarded on the row not
   * being in a lease status); optionally land the run resumable-idle when it
   * isn't terminal (the chat-loop exit path); and — unless the run landed
   * cancelled/closed — re-dispatch if a non-empty user message newer than
   * `lastProcessedUserMsgId` is stranded with no worker to consume it.
   */
  releaseClaim(runId: number, opts: ReleaseClaimOpts): Promise<void>;
  /**
   * Wake `onInput` (best-effort, coalescible) whenever a new user message
   * lands for `runId`. Returns an unsubscribe fn. The db implementation rides
   * Postgres LISTEN 'run_input'; the http implementation rides the /control
   * SSE channel.
   */
  subscribeInput(runId: number, onInput: () => void): Promise<() => void>;

  // inbox + logs
  /** Claim this run's pending inbox events and return the rendered digest
   *  prompt block (or null when the inbox is empty). */
  claimInboxDigest(runId: number): Promise<string | null>;
  /** Persist the tail of the worker's own log for post-mortem debugging. */
  writeWorkerLog(runId: number, tail: string): Promise<void>;

  // domain context (read-mostly; the writes a turn performs on its own task/plan)
  getTask(taskId: string): Promise<TaskFull | null>;
  transitionTask(taskId: string, input: TaskTransitionInput): Promise<void>;
  addTaskNote(taskId: string, author: string, body: string): Promise<void>;
  getPlan(planId: string): Promise<PlanFull | null>;
  listTasks(filter: { planId: string }): Promise<TaskFull[]>;
  updatePlanState(planId: string, state: string): Promise<void>;
  getPersona(personaId: string): Promise<PersonaRecord | null>;
  /** Resolve the repository this run operates on (run.repoId → task's repo →
   *  deployment default), or null when none is configured. */
  resolveRepo(runId: number): Promise<RepositoryRow | null>;
  /** The deployment's repository remotes — what validatePrUrl gates the gh_pr
   *  / gh_ci tools on. Read-only and tiny. */
  listRepoRemotes(): Promise<Array<{ id: string; name: string; remote: string | null }>>;
  /**
   * Claim (or verify) the `pr:<url>` resource lease for this run — the §5.2
   * cross-run PR-mutation guard used by the gh_pr write tools. Returns ok:false
   * with the human-readable refusal when another live run owns the PR.
   */
  acquirePrLock(runId: number, prUrl: string): Promise<{ ok: boolean; reason?: string }>;

  /**
   * Execute an orchestrator tool (the task_orch__* registry) on behalf of this
   * run. In http mode the tool runs SERVER-side — this is what lets an
   * external worker expose the full 37-tool surface to its agent without any
   * database access. `runId` scopes child-run parenting and (over HTTP) is
   * enforced from the bearer token, not the request body.
   */
  callTool(
    runId: number | undefined,
    tool: string,
    params: unknown,
    ctx: ToolCallContext
  ): Promise<ToolCallResult>;
}

// ── shared content helpers ──────────────────────────────────────────────────

/**
 * Concatenated text of a message's content blocks. THE definition of "is this
 * message empty" used by both the chat-loop drain (runs.ts messageText) and
 * the claim-release stranded-message check (db-transport) — a fork here would
 * make the two paths disagree on whether to re-dispatch a follow-up message.
 */
export function contentText(content: SdkContentBlock[]): string {
  return content
    .map((b) =>
      b.type === "text" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""
    )
    .join("")
    .trim();
}

// ── wire (de)serialization ──────────────────────────────────────────────────

/** The exact timestamp keys the wire payloads carry (RunRow, MessageRow,
 *  TaskFull/notes, PlanFull, RepositoryRow, PersonaRecord). Deliberately a
 *  closed list: arbitrary `*At`-suffixed keys inside agent-authored jsonb
 *  (run.result, message content, tool payloads) must NOT be revived, or the
 *  http transport would hand callers different shapes than the db transport. */
const DATE_KEYS = new Set(["createdAt", "updatedAt", "startedAt", "completedAt", "pendingSince", "claimedAt"]);

/** Subtrees that carry agent/user-authored JSON — never descended into. */
const OPAQUE_KEYS = new Set(["content", "result", "payload", "params", "outcome"]);

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Recursively revive ISO-8601 strings under the known timestamp keys back into
 * Date objects. Applied to every JSON payload the HTTP transport receives, so
 * both transports hand the exact same shapes to callers.
 */
export function reviveDates<T>(value: T): T {
  return reviveAny(value, false) as T;
}

function reviveAny(value: unknown, keyIsDate: boolean): unknown {
  if (typeof value === "string") {
    return keyIsDate && ISO_DATE.test(value) ? new Date(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => reviveAny(v, false));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = OPAQUE_KEYS.has(k) ? v : reviveAny(v, DATE_KEYS.has(k));
    }
    return out;
  }
  return value;
}
