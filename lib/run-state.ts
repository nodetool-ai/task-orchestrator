// lib/run-state.ts
//
// The single owner of run status semantics. Before this module the state
// machine was smeared across the codebase: the status vocabulary and the
// terminal/lease sets lived in lib/types.ts, the turn-end landing decision and
// the atomic-write guard constants lived in lib/runs.ts, and the "parking
// contract" (the mutable columns a mid-turn tool writes, reverse-engineered
// into a landing status at turn end) was documented only in a comment block in
// lib/extensions/events.ts. This module pulls all of that into one place:
//
//   • the status vocabulary + `isTerminalStatus` / `LEASE_STATUSES` /
//     `TERMINAL_STATUSES` derived sets;
//   • a data-encoded legal-transition table + `assertTransition`, consulted by
//     the atomic write core (applyStatusTx) — it WARNS on an illegal edge but
//     still allows it (this phase makes the machine visible, not stricter);
//   • the turn-end landing decision (`decideTurnEndStatus`) and its result
//     interpreters (`isFailedResult`, `resultPrUrl`);
//   • the parking contract as real types: `ParkReason`, `ResultKind`, the
//     `TurnEffect` union, and the ONE writer `recordTurnEffect` every mid-turn
//     tool funnels through.
//
// THE PARKING CONTRACT (docs/agent-events.md §6.1). Mid-turn, always-on tools
// (timer__sleep, ask_parent, report_result, raise, await_session) NEVER set
// agent_runs.status directly. They write mutable columns only, and the turn-end
// handler (readTurnEndState + decideTurnEndStatus in lib/runs.ts) maps those
// columns to a landing status:
//   - park_reason      -> mapped to status='parked' at turn end
//   - result           -> mapped to a terminal status + emits child.result /
//                         child.exception to the parent
//   - pending_question -> surfaced by runs.ts / the UI as the open question
// Tool results return instructive text ("End your turn now...") but never
// mutate status themselves. `recordTurnEffect` is the single write path for
// those columns; `decideTurnEndStatus` is the single read/interpret path.
//
// PURITY: this module holds NO database or telemetry imports (only a type-only
// reference to the events-table row shape). App pages import the status
// vocabulary and `isTerminalStatus` from here (via the lib/types re-export), so
// pulling `db` or prom-client in would leak server-only deps into the client
// bundle. Callers inject their DB writer into `recordTurnEffect`, and
// applyStatusTx injects its telemetry recorder into `assertTransition`.

import type { agentEvents } from "@/db/schema";

// ──────────────────────────────────────────────────────────
// Status vocabulary
// ──────────────────────────────────────────────────────────

export const SESSION_STATUSES = [
  "pending",
  "preparing",
  "running",
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

/** Legacy statuses that were once in the vocabulary but are no longer written.
 *  Kept only for defensive hydration of old DB rows (see coerceRunStatus). */
const LEGACY_STATUS_MAP: Record<string, SessionStatus> = {
  // 'pushing' / 'opening_pr' were speculative "a turn is finishing" sub-states
  // that no code path ever wrote. An ancient row carrying one is, semantically,
  // a live turn — map it to 'running' so bucket/lease consumers see a valid
  // current status rather than an unknown string.
  pushing: "running",
  opening_pr: "running",
};

const STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUSES);

/**
 * Defensive parse of a raw `status` column value into the current vocabulary.
 * A known current status passes through; a known legacy status is mapped
 * forward; anything else (a status from a future/parallel writer) is left as-is
 * and trusted — hydrateRun casts it, and the group/bucket helpers already treat
 * unknown statuses as idle rather than dropping the row.
 */
export function coerceRunStatus(raw: string): SessionStatus {
  if (STATUS_SET.has(raw)) return raw as SessionStatus;
  return LEGACY_STATUS_MAP[raw] ?? (raw as SessionStatus);
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

/** The terminal statuses, as an array — the idempotency guard for a terminal
 *  write (applyStatusTx no-ops once the row already sits in one of these). */
export const TERMINAL_STATUSES: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

/** Statuses that mean "a turn is in flight" — the only ones a heartbeat lease
 *  covers. 'parked' (like 'idle') is deliberately NOT a lease status: a parked
 *  run has no worker and no heartbeat and that is HEALTHY (§6.1). Single
 *  source of truth for runs.ts (lease/orphan logic) and the worker transport
 *  (claim-release guard) — the two must never drift, or a claim release could
 *  clear a healthy worker's claim mid-turn. */
export const LEASE_STATUSES: SessionStatus[] = ["running", "preparing"];

/** Statuses that a dispatch/server-turn claim must never revive in place. */
export const HARD_TERMINAL_STATUSES: SessionStatus[] = ["cancelled", "closed"];

// ──────────────────────────────────────────────────────────
// Legal-transition table
// ──────────────────────────────────────────────────────────
//
// Encoded as data, derived from the actual transition sites (create, the
// dispatch claim, setStatus→running, the decideTurnEndStatus landings,
// interrupt, cancel, close, the orphan reaper, worker-death handling,
// failPendingRun, and the dispatch pump's re-defer). Consulted at runtime by
// applyStatusTx via assertTransition. This phase only WARNS on an unlisted
// edge — the table exists to make the machine visible, not to reject writes —
// so a self-transition and any entry-state write is treated as legal too.
//
// SURPRISING-BUT-REAL edges the table documents:
//   • completed / failed / budget_exhausted -> preparing | running: a "terminal"
//     run is re-driven on a follow-up turn. A worktree run's branch + checkout
//     persist, so append() re-drives it to 'running' and the dispatch claim
//     re-claims it to 'preparing' (isResumableWorktreeRun). These land through
//     setStatus/the claim, NOT applyStatusTx, so the runtime check never sees
//     them — but the table records them as legal.
//   • running -> running: a turn that must produce a PR but hasn't yet
//     (requiresPrUrl) re-lands 'running' at turn end (decideTurnEndStatus).
//   • pending -> pending: the dispatch pump re-defers an unclaimable run.
export const STATUS_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  // Freshly created rows are born here; the pump may re-defer a pending row,
  // dispatch claims it to 'preparing', a server-side run drives it straight to
  // 'running', and failPendingRun / cancel / close can end it early.
  pending: ["preparing", "running", "pending", "failed", "cancelled", "closed", "idle"],
  // The dispatch claim's landing state: the worker adopts it to 'running', or
  // the reaper/worker-death fails it, or a cancel/close/interrupt intervenes.
  preparing: ["running", "failed", "cancelled", "closed", "idle"],
  // The in-flight state: every turn-end landing (decideTurnEndStatus) plus the
  // reaper/worker-death failure and cancel/close.
  running: [
    "completed",
    "failed",
    "cancelled",
    "budget_exhausted",
    "idle",
    "parked",
    "running",
    "closed",
  ],
  // A parked run has no worker; a wake re-drives it (append→running,
  // claim→preparing) or a cancel/close ends it. The reaper never fails a parked
  // run (not a lease status), but a raced cancel/close still can.
  parked: ["running", "preparing", "cancelled", "closed"],
  // Chat/idle runs resume on the next message (→running) or via a claim
  // (→preparing); the user can close/cancel them, or report_result can land a
  // terminal status on the resumed turn.
  idle: ["running", "preparing", "cancelled", "closed", "completed", "failed"],
  // Resumable terminals — a follow-up turn re-drives a worktree run whose
  // branch + checkout persist, or a plan executor whose state is durable task
  // rows (runs.isResumableRun).
  completed: ["preparing", "running"],
  failed: ["preparing", "running"],
  budget_exhausted: ["preparing", "running"],
  // Hard-stop terminals: cancelled needs a fork, closed is archived. Neither is
  // ever revived in place.
  cancelled: [],
  closed: [],
};

/** Pure predicate: is `from -> to` a legal edge? A self-transition is always
 *  legal (several turn-end / idempotent paths re-write the same status). */
export function isLegalTransition(from: SessionStatus, to: SessionStatus): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Consulted by applyStatusTx (the atomic write core). On an illegal edge it
 * logs a warning and invokes the optional telemetry hook, then RETURNS the
 * legality (the caller ALLOWS the write regardless — this phase makes the
 * machine visible, it does not enforce it). Telemetry is injected rather than
 * imported so this module stays free of prom-client / server-only deps.
 */
export function assertTransition(
  from: SessionStatus,
  to: SessionStatus,
  onIllegal?: (from: SessionStatus, to: SessionStatus) => void
): boolean {
  const legal = isLegalTransition(from, to);
  if (!legal) {
    console.warn(
      `[run-state] illegal status transition ${from} -> ${to} (allowing; this phase warns only)`
    );
    onIllegal?.(from, to);
  }
  return legal;
}

// ──────────────────────────────────────────────────────────
// Status-event row shape
// ──────────────────────────────────────────────────────────

/** The single source of truth for a `status` event row's shape. Both
 *  applyStatusTx (transactional) and emitStatus (non-terminal, best-effort)
 *  build their INSERT through here so the payload the reaper's latestEventStatus
 *  parser reads back can never drift between the two writers. */
export function buildStatusEventValues(
  runId: number,
  status: SessionStatus,
  extra?: Record<string, unknown>
): typeof agentEvents.$inferInsert {
  return {
    sessionId: runId,
    type: "status",
    payload: JSON.stringify({ status, ...(extra ?? {}) }),
    createdAt: new Date(),
  };
}

// ──────────────────────────────────────────────────────────
// The parking contract: typed turn effects
// ──────────────────────────────────────────────────────────

/** Why a run parked (agent_runs.park_reason). 'sleeping' = timer__sleep,
 *  'waiting' = await_session, 'question' = ask_parent. */
export type ParkReason = "sleeping" | "waiting" | "question";
export const PARK_REASONS: readonly ParkReason[] = ["sleeping", "waiting", "question"];

/** The two shapes agent_runs.result can hold. 'result' = report_result,
 *  'exception' = raise. */
export type ResultKind = "result" | "exception";
export const RESULT_KINDS: readonly ResultKind[] = ["result", "exception"];

/** A report_result payload (agent_runs.result, kind='result'). */
export interface ResultReport {
  kind: "result";
  status: "success" | "failed" | "blocked";
  summary: string;
  data: Record<string, unknown> | null;
  pr_url: string | null;
  needs: string | null;
  reported_at: string;
}

/** A raise payload (agent_runs.result, kind='exception'). */
export interface ResultException {
  kind: "exception";
  code: string;
  message: string;
  recoverable: boolean;
  details: Record<string, unknown> | null;
  raised_at: string;
}

export type ResultPayload = ResultReport | ResultException;

/** An open ask_parent question (agent_runs.pending_question). */
export interface PendingQuestion {
  question_id: string;
  question: string;
  context?: unknown;
  asked_at: string;
  deadline: string;
  state: "open" | "answered" | "expired";
  answered_at?: string;
  assumption?: string;
}

/**
 * A mid-turn tool's intent, expressed as data rather than a direct column
 * write. `recordTurnEffect` translates it to the exact column patch the old
 * inline writers produced; `decideTurnEndStatus` reads those columns back and
 * interprets them into a landing status.
 */
export type TurnEffect =
  | { kind: "park"; reason: ParkReason }
  | { kind: "result"; payload: ResultPayload; resultKind: ResultKind }
  | { kind: "question"; question: PendingQuestion };

/** The mutable agent_runs columns a turn effect writes. */
export interface TurnEffectColumns {
  parkReason?: ParkReason;
  result?: ResultPayload;
  pendingQuestion?: PendingQuestion;
}

/**
 * Pure mapping from a turn effect to its column patch — the single place the
 * park/result/question → column shape is defined. Matches the historical inline
 * writes exactly:
 *   - park     -> { parkReason }
 *   - result   -> { result }
 *   - question -> { pendingQuestion, parkReason: 'question' }  (ask_parent set BOTH)
 */
export function turnEffectColumns(effect: TurnEffect): TurnEffectColumns {
  switch (effect.kind) {
    case "park":
      return { parkReason: effect.reason };
    case "result":
      return { result: effect.payload };
    case "question":
      return { pendingQuestion: effect.question, parkReason: "question" };
  }
}

/** How `recordTurnEffect` writes columns — a caller-injected patch applier
 *  (in practice a db.update / transport patchRun closure bound to the run id).
 *  Injected so this module needs no `db` import. */
export type RunColumnWriter = (columns: TurnEffectColumns) => Promise<unknown>;

/**
 * The ONE writer for the parking-contract columns. Every mid-turn tool
 * (timer__sleep, await_session, report_result, raise, ask_parent) routes its
 * column write through here so the shape is defined in exactly one place and
 * the same patch flows whether the tool ran on the orchestrator or (in the
 * future) elsewhere — the caller supplies the actual write via `write`.
 */
export async function recordTurnEffect(
  write: RunColumnWriter,
  effect: TurnEffect
): Promise<void> {
  await write(turnEffectColumns(effect));
}

// ──────────────────────────────────────────────────────────
// Turn-end landing decision (§6.1)
// ──────────────────────────────────────────────────────────

/** True if a result payload signals failure — a raise ({code}) or a
 *  report_result whose status is failed/blocked/error. */
export function isFailedResult(result: unknown): boolean {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as { status?: unknown; code?: unknown };
  return (
    typeof r.code === "string" ||
    r.status === "failed" ||
    r.status === "blocked" ||
    r.status === "error"
  );
}

/** The PR url a result payload carries (pr_url / prUrl), trimmed, or null. */
export function resultPrUrl(result: unknown): string | null {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return null;
  const prUrl =
    (result as { pr_url?: unknown; prUrl?: unknown }).pr_url ??
    (result as { prUrl?: unknown }).prUrl;
  return typeof prUrl === "string" && prUrl.trim() ? prUrl.trim() : null;
}

export interface TurnEndDecisionInput {
  goal: string;
  /** Status re-read from the DB at turn end (a tool may have landed one). */
  freshStatus: SessionStatus;
  /** agent_runs.park_reason re-read at turn end. */
  parkReason: string | null;
  /** agent_runs.result re-read at turn end. */
  result: unknown;
  budgetHit: boolean;
  /** What the legacy logic would land: 'completed' (implement) or 'idle' (chat). */
  defaultStatus: SessionStatus;
  /** Implement-style runs must not report success until a PR exists. */
  requiresPrUrl?: boolean;
  /** PR observed either from git sync, the run row, task row, or report_result. */
  prUrl?: string | null;
}

/**
 * Turn-end landing decision (§6.1) — the parking contract with the tools
 * layer, pure so it's unit-testable. Priority:
 *   1. result written this turn → the tool's terminal status if it already
 *      wrote one; else failed for raise-shaped payloads ({code}/status:
 *      'failed'|'blocked'), or completed only when any required PR exists.
 *   2. a cancel/close that raced in wins (the caller's WHERE guard is the
 *      real protection; this keeps the decision honest too).
 *   3. budget exhaustion beats parking — an exhausted run must not sleep.
 *   4. implement-style PR requirements beat parking; the agent must either
 *      produce a PR or explicitly fail.
 *   5. park_reason set on a run that would otherwise land completed/idle →
 *      'parked'. This includes chat runs: await_session/timer tools must yield
 *      the chat turn and let inbox events wake it without a polling loop.
 *   6. otherwise the legacy default.
 */
export function decideTurnEndStatus(i: TurnEndDecisionInput): SessionStatus {
  if (i.result != null) {
    if (isTerminalStatus(i.freshStatus)) return i.freshStatus;
    const failedish = isFailedResult(i.result);
    if (failedish) return "failed";
    if (i.budgetHit) return "budget_exhausted";
    if (i.requiresPrUrl && !(i.prUrl ?? resultPrUrl(i.result))) return "running";
    return "completed";
  }
  if (i.freshStatus === "cancelled" || i.freshStatus === "closed") return i.freshStatus;
  if (i.budgetHit) return "budget_exhausted";
  if (i.requiresPrUrl && !i.prUrl) return "running";
  if (
    i.parkReason != null &&
    (i.defaultStatus === "completed" || i.defaultStatus === "idle")
  ) {
    return "parked";
  }
  return i.defaultStatus;
}
