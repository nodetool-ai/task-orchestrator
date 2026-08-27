// Unified run runner.
//
// A "run" is one row in agent_runs. It encapsulates a Claude Agent SDK
// conversation that may span many user messages. The shape of the run is
// captured by three independent dials:
//
//   • goal          — '<implement>' (worktree → branch → PR) | '<chat>' (no
//                     git lifecycle) | a free-form description for ad-hoc runs
//   • cwdStrategy   — 'worktree' (create a fresh git worktree on a new
//                     branch) | 'repo' (run in the repo's local_path) |
//                     'none' (run in the orchestrator checkout, falls back
//                     to default repo)
//   • toolsProfile  — comma-separated list of profile names; each contributes
//                     one or more MCP servers to the SDK call. Registry below.
//
// Lifecycle:
//   1. runs.create() inserts the row, optionally kicks off the implement-style
//      worker (worktree → first agent turn → push → PR → idle/completed).
//   2. runs.append() persists a new user/system message and, if the run is
//      idle, drives one turn through the configured agent backend. Concurrent
//      appends on the same run are serialised by an in-process lock so turns
//      never race against themselves.
//   3. On stream end the run lands at `idle` (chat-style) or `completed`
//      (implement-style after PR). Errors → `failed`. Budget caps hit →
//      `budget_exhausted`. User cancellation → `cancelled`.
//   4. Worktree re-materialization: when resuming a worktree run whose
//      .worktrees/<id> directory has been pruned (server restart, manual
//      cleanup), runs.append() runs `git worktree add <path> <branch>` to
//      restore it before invoking the SDK.

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import { agentEvents, agentMessages, agentSessions, runTimers, runnerInstances, tasks } from "@/db/schema";
import { describe } from "@/lib/utils";
import { parseProviderQualifiedModel } from "@/lib/model-id";
import * as repo from "./repo";
import {
  buildExecutePrompt,
  buildImplementPrompt,
  extractReviewOutcome,
  parseReviewVerdict,
} from "./run-templates";
import { parsePrUrl, ownerRepoFromRemote } from "./gh-url";
import { getOctokit } from "./github-client";
import { assistantText, toolResults, type SdkContentBlock } from "./sdk-message";
import type { AgentSessionFull, RepositoryRow } from "./types";
// The run status vocabulary + state machine live in lib/run-state.ts. Pull the
// pieces runs.ts needs directly from there (types.ts only re-exports a subset).
import type { ResultReport, SessionStatus, TurnEndDecisionInput } from "./run-state";
import {
  isTerminalStatus,
  LEASE_STATUSES,
  HARD_TERMINAL_STATUSES,
  SESSION_STATUSES,
  TERMINAL_STATUSES,
  coerceRunStatus,
  assertTransition,
  buildStatusEventValues,
  decideTurnEndStatus,
  isFailedResult,
  resultPrUrl,
} from "./run-state";
import { config, runnerProviderKind, type RunnerProviderKind } from "./config";
import {
  resolveLiveness,
  serverClaimScope,
  isResumableDeadRun,
  decideDeadRunPolicy,
} from "./run-liveness";
import { isServerRuntimeRun } from "./run-runtime";
import { isTransientNetworkError } from "./transient-errors";
import {
  resolveProfiles,
  alwaysOnExtensions,
  listServerSafeProfiles,
  serverUnsafeProfiles,
  type ProfileContext,
} from "./profiles";
import { type RunEnvelope } from "./pi-event-mapper";
import { estimateCostUsd } from "./pricing";
import { getBackend, resolveBackendId, type ContextSource, type Extension } from "./agent-backend";
import {
  cancelPendingTimersForRun,
  cancelTimersByCorrelation,
  claimInboxEventsTx,
  emitInboxEvent,
  hasPendingInboxEvents,
  pendingOwnerCount,
  quarantineEvent,
  setClaimTurn,
  takeUnrenderedControlEvents,
  toEnvelope,
  type EventEnvelope,
} from "./inbox";
import { sandboxFactory } from "./extensions/sandbox";
import { envScrubFactory } from "./extensions/env-scrub";
import { personaPromptFactory } from "./extensions/persona-prompt";
import { buildMemoryInjection, personaMemoryFactory } from "./extensions/persona-memory";
import { modelWelfareFactory } from "./extensions/model-welfare";
import { abortBridgeFactory } from "./extensions/abort-bridge";
import { linkSharedWorktreeArtifacts } from "./worktree-env";
import { applyPrewarmToCheckout } from "./prewarm";
import {
  observeRunnerPhase,
  recordRunnerEvent,
  recordStatusTransition,
  recordIllegalTransition,
  timeRunnerPhase,
} from "./runner/telemetry";
// Namespace import (not `await import`) because reconcileOrphanedRuns() is
// synchronous, and calling through the namespace (runDispatch.dispatchRun) keeps
// vi.spyOn(dispatch, "dispatchRun") observable for the reconcile/routing tests.
// run-dispatch does NOT import from this module; instead we inject get()/
// isLeaseLive() into it below. That keeps the only static edge runs → run-dispatch
// (no cycle), avoiding the webpack-minified boot TDZ a runs ↔ run-dispatch cycle
// would otherwise produce.
import * as runDispatch from "./run-dispatch";
import { runNonce } from "./run-nonce";
// The control-plane transport seam (lib/worker): every interaction the web
// server / CLI has with run state goes through runTransport(), which is always
// the db transport (this process IS the orchestrator). Dispatched workers never
// construct a transport — they run over the WebSocket channel (lib/worker-channel).
// The import is cycle-safe: lib/worker/index only pulls types + the logger at
// module init and loads the db transport implementation lazily.
import { contentText, runTransport } from "./worker";

// Inject this module's helpers into run-dispatch (see the comment above). `get`,
// `isLeaseLive`, and `setError` are hoisted function declarations, so they are
// safe to reference at module-init time. `failRun` lets a failed worker spawn
// mark the run failed (status + event) instead of wedging it in 'preparing'.
// It binds recordDispatchFailure (not bare setError) so a RE-dispatch of an
// already-failed run — a user resuming it — still records why THIS attempt
// failed instead of no-oping behind the terminal guard.
runDispatch.__setRunsApi({
  get,
  failRun: recordDispatchFailure,
  failPendingRun,
  countInFlightWorkers,
  listPendingRunIds,
  reconcileOrphanedRuns,
  listLeasedRuns,
  handleWorkerDeath,
  checkTreeLimits,
  wakeServerRun,
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = config.agent.model ?? "anthropic/claude-opus-4-8";
const KEEP_WORKTREES = config.features.keepWorktrees;

function runnerProviderLabel(): RunnerProviderKind {
  return runnerProviderKind();
}

const SANDBOX_OPTS = {
  enabled: true as const,
  autoAllowBashIfSandboxed: true as const,
};

// ──────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────

export type Goal = "<implement>" | "<chat>" | "<review>" | "<execute>" | (string & {});
export type CwdStrategy = "worktree" | "worktree_at_pr" | "repo" | "none";

export interface Budget {
  maxTurns?: number;
  maxUsd?: number;
  maxSeconds?: number;
}

export interface CreateRunInput {
  goal: Goal;
  toolsProfile?: string;
  cwdStrategy?: CwdStrategy;
  repoId?: string | null;
  taskId?: string | null;
  /** Plan a chat is scoped to (no effect on implement/review runs). */
  planId?: string | null;
  prUrl?: string | null;
  parentRunId?: number | null;
  model?: string | null;
  /** Agent backend for this run ('pi'|'claude'). Omitted/null inherits the
   *  deployment default (TASK_ORCH_AGENT_BACKEND). */
  backend?: string | null;
  /** Reasoning level for this run; overrides the persona's. Omitted/null
   *  inherits the persona's level (which may itself be unset = model default). */
  thinkingLevel?: "low" | "medium" | "high" | "xhigh" | null;
  budget?: Budget | null;
  userId?: number | null;
  title?: string | null;
  personaId?: string | null;
  /** For implement-style runs: the base branch the worktree branches from. */
  baseBranch?: string;
  /** Optional initial agent prompt; if omitted the run waits for runs.append. */
  initialPrompt?: string | null;
  /** If true, do NOT kick off the worker on create; useful for chats. */
  defer?: boolean;
  /**
   * Execution placement for this run. Default 'worker': a detached process /
   * container / Machine, the tier every repo-touching run uses.
   *
   * 'server' means the run's turns execute IN this process (the web server or
   * the pipe) through the postgres-turn loop — no container, no worktree, no
   * SDK session file. It exists for persona chats (docs/superpowers/specs/
   * 2026-07-31-discord-personas-messaging-design.md §3): a chat turn per
   * Discord message is the wrong shape for a Fly Machine.
   *
   * DELIBERATELY NOT EXPOSED on POST /api/runs — an external caller must not be
   * able to opt a run into the server process. Internal callers only (the pipe's
   * session store). Guarded further at create time: server runtime requires the
   * pi backend and a tools profile with no shell/fs/repo-write capability.
   */
  runtime?: "worker" | "server";
}

// /runs UI distinguishes task-derived runs from chat-derived runs.
// Task-derived: row has a non-null taskId (or goal === '<implement>').
// Chat-derived: no taskId (or goal === '<chat>'), and may have a
// legacyChatId for pre-migration-0009 ids.
export type RunOrigin = "task" | "chat";

export interface RunRow {
  id: number;
  goal: string;
  status: SessionStatus;
  /** Derived: 'task' if taskId is set, else 'chat'. Used by the /runs UI. */
  origin: RunOrigin;
  taskId: string | null;
  /** Plan this run is scoped to (chat-with-a-plan). */
  planId: string | null;
  repoId: string | null;
  parentRunId: number | null;
  toolsProfile: string;
  cwdStrategy: CwdStrategy;
  /** Execution placement, chosen per run at create time (design §3).
   *  'worker' (the default) is a detached process/container/Machine; 'server'
   *  means the turn runs in-process through the postgres-turn loop — persona
   *  chats only, internal callers only. Legacy pre-retirement rows may also
   *  carry 'server', paired with an unsafe tools profile that create() would
   *  refuse today.
   *
   *  NEVER branch on this column directly. Every turn-time placement decision
   *  goes through `isServerRuntimeRun` (lib/run-runtime.ts), which requires the
   *  placement AND the tool surface to agree and demotes a legacy row to worker
   *  otherwise. A raw `runtime === 'server'` read would hand those rows the
   *  unsandboxed, unscrubbed in-process path. */
  runtime: "server" | "worker";
  model: string | null;
  /** Agent backend this run executes on ('pi'|'claude'), or null for the
   *  deployment default (TASK_ORCH_AGENT_BACKEND). */
  backend: "pi" | "claude" | null;
  /** Per-run reasoning level (low|medium|high|xhigh), or null to inherit the persona. */
  thinkingLevel: "low" | "medium" | "high" | "xhigh" | null;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  error: string | null;
  outcome: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sdkSessionId: string | null;
  budgetMaxTurns: number | null;
  budgetMaxUsd: number | null;
  budgetMaxSeconds: number | null;
  userId: number | null;
  title: string | null;
  personaId: string | null;
  /** Pre-migration-0009 chats.id, for /chat/[id] redirect lookups. */
  legacyChatId: number | null;
  /** Null for ordinary runs; set to 'gathering' when a planning run is created. */
  planningStage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  /** Start of the current pending episode (bounds the dispatch pump's max defer). */
  pendingSince: Date | null;
  /** When the current worker claim was taken. Bookkeeping, not liveness. */
  claimedAt: Date | null;
  /** The worker scope/container that owns this run, or null. */
  workerScope: string | null;
  /** Detached worker (0020): 1 = cross-process cancel requested; the worker aborts at the next poll. */
  cancelRequested: number | null;
  /** Event system (§4.3): rework generation; bumped when a terminal-but-resumable run starts a new turn. */
  attempt: number;
  /** Event system (§4): structured result written by report_result/raise THIS turn, or null. */
  result: unknown | null;
  /** Event system (§6.1): why a 'parked' run is parked ('waiting'|'sleeping'|'question'), or null. */
  parkReason: string | null;
  /** Why a 'pending' run is pending: the admission defer reason, or null. */
  pendingReason: string | null;
}

export interface MessageRow {
  id: number;
  runId: number;
  role: "user" | "agent" | "tool" | "system";
  content: SdkContentBlock[];
  createdAt: Date;
}

export interface ListFilter {
  goal?: Goal;
  status?: SessionStatus | SessionStatus[];
  taskId?: string | null;
  planId?: string | null;
  userId?: number | null;
  repoId?: string;
  parentRunId?: number;
  /** When true, exclude terminal statuses. */
  activeOnly?: boolean;
  /** Cap the number of rows returned (most-recent-first). */
  limit?: number;
}

export interface AppendInput {
  runId: number;
  role: "user" | "system";
  text: string;
  /** Optional author label for any tasks/notes the agent creates. */
  author?: string;
  /** External abort handle; if omitted the runner makes its own. */
  abort?: AbortController;
  /** For a worktree run's FIRST turn: the base branch to branch from / open the
   *  PR against. Ignored once the run's branch exists. Falls back to the repo
   *  default branch when unset. */
  baseBranch?: string;
  /** Set by a dispatched worker driving the FIRST turn of a run it just claimed.
   *  dispatchRun leaves the run in `preparing` with a fresh heartbeat, which the
   *  in-flight guard below would otherwise read as "live in another process" and
   *  reject. The atomic claim guarantees a single worker per run, so the claim IS
   *  proof of ownership — this flag lets that worker adopt its own `preparing`
   *  claim. Only honored for `preparing` (never `running`). */
  takeover?: boolean;
  /** Default true. Set false when the triggering user message is ALREADY in the
   *  DB (the server persisted it to fire the run_input NOTIFY before dispatching
   *  the worker). The worker then runs the turn on `text` without re-inserting a
   *  duplicate user row. In-process/legacy callers leave it unset. */
  persistUser?: boolean;
  /** True for event-only wakeups: `text` is an ephemeral model prompt, not an
   *  existing user row and not something that should be shown in the transcript. */
  ephemeralInput?: boolean;
  /** Postgres-mode: the id of the persisted user row this turn is processing.
   *  When a backlog of user messages is drained oldest-first (one turn each),
   *  this pins context reconstruction/annotation to the message actually being
   *  handled — without it both target the NEWEST user row, so an earlier turn
   *  would splice its text into a later message's row. Unset → latest row. */
  inputMessageId?: number;
}

export interface AppendStreamEvent {
  type: "user_message" | "sdk" | "done" | "error";
  /** On `user_message` frames: the persisted user/system row. On `sdk` frames:
   *  the persisted agent/tool row backing the envelope, when one exists — the
   *  client dedups by its real DB id against the read-only /events tail, which
   *  delivers the same rows to every viewer (including the sender). */
  message?: MessageRow;
  sdk?: RunEnvelope;
  error?: string;
}

// ──────────────────────────────────────────────────────────
// In-process state (held on globalThis to survive HMR)
// ──────────────────────────────────────────────────────────

interface RunnerState {
  abort: AbortController;
  bus: EventEmitter;
}

interface PerRunLock {
  /** Resolves when the current in-flight append finishes. */
  busy: Promise<void> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __runRunners: Map<number, RunnerState> | undefined;
  // eslint-disable-next-line no-var
  var __runLocks: Map<number, PerRunLock> | undefined;
  // eslint-disable-next-line no-var
  var __runPendingSubs: Map<number, Set<(event: unknown) => void>> | undefined;
}

const runners: Map<number, RunnerState> = globalThis.__runRunners ?? new Map();
if (!globalThis.__runRunners) globalThis.__runRunners = runners;

const locks: Map<number, PerRunLock> = globalThis.__runLocks ?? new Map();
if (!globalThis.__runLocks) globalThis.__runLocks = locks;

/**
 * Listeners that asked to hear a run's events BEFORE the run went live (see
 * subscribeRunEvents). A run's bus only exists while a turn is in flight, so a
 * caller that kicks a turn and then subscribes has an unavoidable race: a fast
 * turn can register, emit and close its bus before the subscribe lands, and the
 * caller sees nothing at all. These listeners are attached the moment a runner
 * registers, which makes "subscribe, then start the turn" expressible.
 */
const pendingSubscribers: Map<number, Set<(event: unknown) => void>> =
  globalThis.__runPendingSubs ?? new Map();
if (!globalThis.__runPendingSubs) globalThis.__runPendingSubs = pendingSubscribers;

/** The one place a run's in-process runner is published (bus + abort handle).
 *  Routed through here so pre-subscribed listeners (above) are attached to the
 *  bus before it can emit anything. */
function registerRunner(runId: number, state: RunnerState): void {
  runners.set(runId, state);
  const waiting = pendingSubscribers.get(runId);
  if (waiting) for (const listener of waiting) state.bus.on("event", listener);
}

function getLock(runId: number): PerRunLock {
  let l = locks.get(runId);
  if (!l) {
    l = { busy: null };
    locks.set(runId, l);
  }
  return l;
}

// ──────────────────────────────────────────────────────────
// Tree limits (docs/nested-machine-dispatch.md, Decision 2)
// ──────────────────────────────────────────────────────────
// Bound how deep and how large a parent_run_id tree can grow, so a worker that
// spawns children (and whose children later become real, billable Fly Machines)
// can't fan out without limit. Checked in create() (friendly, synchronous tool
// error) AND re-verified in dispatchRun (defense in depth: a worker writing rows
// directly, bypassing create(), still can't get a Machine past the server-side
// check). Both call sites funnel through evaluateTreeLimits so the two produce
// byte-identical messages.

// Read fresh per call (config changes take effect without a restart, matching
// lib/run-dispatch.ts's intEnv). 0 or negative disables the corresponding check.
function treeLimitEnv(key: string, dflt: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
}

// Hard stop for the parent-chain walks below, paired with a visited-set cycle
// guard: a self-referential/cyclic parent_run_id graph (shouldn't happen, but
// nothing enforces it at the DB level) must not hang a create()/dispatchRun call.
const MAX_PARENT_WALK = 64;

// Hard ceiling on the "keep going until there's a PR" continuation loop in
// append(). An implement-worktree turn that ends without a PR (and without
// report_result/raise) re-lands 'running', and the loop re-prompts the agent to
// continue. The configured budgets bound this only partially: budgetMaxSeconds/
// budgetMaxUsd catch it only when set, and budgetMaxTurns is counted per
// runOneTurn — NOT cumulatively across continuations — so an agent that keeps
// ending turns quickly without ever opening a PR would loop forever. Cap the
// number of consecutive no-PR continuations; on exhaustion, land 'failed' with a
// structured result instead of spinning. Tunable via env; floored at 2 so the
// loop always makes at least one continuation attempt before giving up —
// prContinuations is incremented BEFORE the `>=` cap test, so a floor of 1 would
// trip the cap on the very first no-PR turn (zero continuations).
export const MAX_PR_CONTINUATIONS = Math.max(
  2,
  Math.floor(Number(process.env.TASK_ORCH_MAX_PR_CONTINUATIONS ?? 25)) || 25
);

/**
 * The structured failure a run lands when the no-PR continuation loop hits its
 * ceiling. Pure (timestamp injected) so the payload is unit-testable without
 * driving the whole append() generator. Mirrors a report_result({ status:
 * "failed" }) so the stop is observable and the run stays resumable.
 */
export function prContinuationFailureResult(
  count: number,
  max: number,
  reportedAt: string
): ResultReport {
  return {
    kind: "result",
    status: "failed",
    summary:
      `Stopped after ${count} turns without producing a PR ` +
      `(TASK_ORCH_MAX_PR_CONTINUATIONS=${max}). The agent kept ending turns without ` +
      "opening a pull request and without calling report_result/raise, so the run was " +
      "failed to avoid an infinite loop.",
    data: null,
    pr_url: null,
    needs: null,
    reported_at: reportedAt,
  };
}

/** A run's own parent_run_id, or null if the run has none — or no longer exists
 *  (parent_run_id carries no FK, so an ancestor can be deleted out from under
 *  its descendants). Shared by the parent-chain walks below. */
async function fetchParentRunId(id: number): Promise<number | null> {
  const row: { parentRunId: number | null } | undefined = (
    await db
      .select({ parentRunId: agentSessions.parentRunId })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
  )[0];
  return row?.parentRunId ?? null;
}

/**
 * Depth a new run would have if created with `parentRunId` as its parent (root =
 * depth 0, so a direct child of a root is depth 1). Walks agent_sessions'
 * parent_run_id chain upward one row at a time — the chain is short in practice,
 * so a bounded loop reads more plainly here than a recursive CTE. Robust to a
 * dangling parentRunId: parent_run_id carries no FK, so an ancestor row can be
 * deleted out from under its descendants; when the walk can't find a row it just
 * stops there (treats the missing ancestor as if it were the root), rather than
 * throwing.
 */
async function wouldBeDepth(parentRunId: number): Promise<number> {
  let depth = 1; // the new run sits one level below parentRunId
  let currentId: number | null = parentRunId;
  const visited = new Set<number>();
  for (let i = 0; i < MAX_PARENT_WALK && currentId != null; i++) {
    if (visited.has(currentId)) break; // cyclic parent_run_id graph
    visited.add(currentId);
    const parent = await fetchParentRunId(currentId); // no row (deleted parent) => null, stop here
    if (parent == null) break;
    depth++;
    currentId = parent;
  }
  return depth;
}

/**
 * Root id of the tree containing `startId` — walks parent_run_id upward until it
 * finds a run with no parent (or a dangling one; see wouldBeDepth). Same
 * cycle/iteration bound as wouldBeDepth.
 */
async function findTreeRoot(startId: number): Promise<number> {
  let currentId = startId;
  const visited = new Set<number>();
  for (let i = 0; i < MAX_PARENT_WALK; i++) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const parent = await fetchParentRunId(currentId);
    if (parent == null) break;
    currentId = parent;
  }
  return currentId;
}

/**
 * Total number of runs (any status) sharing rootId's tree. The tree can fan out
 * wide (unlike the parent-chain walks above, which are single-path), so this is
 * a set-based recursive CTE rather than another app-level loop.
 */
async function countTreeRuns(rootId: number): Promise<number> {
  const rows = await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM agent_runs WHERE id = ${rootId}
      UNION ALL
      SELECT s.id FROM agent_runs s JOIN tree t ON s.parent_run_id = t.id
    )
    SELECT count(*)::int AS count FROM tree
  `);
  const first = (rows as unknown as Array<{ count: number }>)[0];
  return Number(first?.count ?? 0);
}

/**
 * Depth + tree-size check shared by create() and dispatchRun's re-verify (via
 * checkTreeLimits below), so both surfaces reject with the exact same message.
 * `extraTreeRuns` accounts for a run not yet in the table: create() calls this
 * BEFORE inserting the new row (extraTreeRuns=1, counting the run-to-be), while
 * checkTreeLimits calls it for a run that already exists (extraTreeRuns=0, it's
 * already part of the CTE's count).
 */
async function evaluateTreeLimits(
  parentRunId: number,
  opts: { extraTreeRuns: number }
): Promise<string | null> {
  const maxDepth = treeLimitEnv("TASK_ORCH_MAX_RUN_DEPTH", 3);
  const maxTreeRuns = treeLimitEnv("TASK_ORCH_MAX_TREE_RUNS", 32);
  if (maxDepth > 0) {
    const depth = await wouldBeDepth(parentRunId);
    if (depth > maxDepth) {
      return `run tree depth ${depth} exceeds TASK_ORCH_MAX_RUN_DEPTH=${maxDepth} (parent_run_id nesting cap; see docs/nested-machine-dispatch.md)`;
    }
  }
  if (maxTreeRuns > 0) {
    const root = await findTreeRoot(parentRunId);
    const size = (await countTreeRuns(root)) + opts.extraTreeRuns;
    if (size > maxTreeRuns) {
      return `run tree size ${size} exceeds TASK_ORCH_MAX_TREE_RUNS=${maxTreeRuns} (total runs sharing this run's root; see docs/nested-machine-dispatch.md)`;
    }
  }
  return null;
}

/**
 * Server-side re-verify for dispatchRun (defense in depth): a worker that writes
 * run rows directly, bypassing create()'s check, must still not get a Machine
 * past this. No-op (returns null) for a root run (no parentRunId) — a run that
 * ever had its parent link removed is not re-checked either, matching create()'s
 * dangling-parent tolerance. Injected into lib/run-dispatch.ts via __setRunsApi
 * below (run-dispatch has no static import of this module — see the import-cycle
 * note by that call).
 */
export async function checkTreeLimits(runId: number): Promise<string | null> {
  const run = await get(runId);
  if (!run || run.parentRunId == null) return null;
  return evaluateTreeLimits(run.parentRunId, { extraTreeRuns: 0 });
}

// ──────────────────────────────────────────────────────────
// CRUD: create / list / get
// ──────────────────────────────────────────────────────────

export async function create(input: CreateRunInput): Promise<RunRow> {
  const goal = input.goal ?? "<chat>";
  const cwdStrategy: CwdStrategy =
    input.cwdStrategy ??
    (goal === "<chat>" || goal === "<plan>"
      ? "none"
      : goal === "<execute>"
        ? "repo"
        : "worktree");
  const toolsProfile =
    input.toolsProfile ??
    (goal === "<execute>"
      ? "orchestrator,spawn"
      : "orchestrator,repo_write");
  const initialStatus: SessionStatus =
    input.defer || goal === "<chat>" || goal === "<plan>" ? "idle" : "pending";
  const runtime: "worker" | "server" = input.runtime ?? "worker";

  // Server-runtime guardrail (design §3/§6). A server-runtime turn executes in
  // THIS process — no container, no worktree, the server's own uid, DATABASE_URL
  // and credentials in reach — so the tool surface is the whole sandbox. Reject
  // any profile that can reach a shell, the filesystem, or a repo write BEFORE
  // the insert (same reasoning as the worktree/plan invariants below: a rejection
  // after the insert leaves an undriveable ghost row).
  if (runtime === "server") {
    // No worktree, no checkout: a server-runtime turn has nothing to contain a
    // working copy with, and the kickoff/dispatch branches below are worker-only.
    // §3: persona chats are `cwdStrategy: 'none'`.
    if (cwdStrategy !== "none") {
      throw new repo.RepoError(
        `runtime='server' requires cwdStrategy='none' (got '${cwdStrategy}'): an in-process run ` +
          `has no container to hold a checkout. Spawn a worker run for repo-backed work.`,
        400
      );
    }
    // No tier would ever drive this row (M2 review finding 3). initialStatus is
    // 'pending' for any non-deferred goal that isn't <chat>/<plan>, and 'pending'
    // on a SERVER row is a dead end: listPendingRunIds is the worker dispatch
    // queue (so no pump retry and no max-defer failer), it isn't 'parked' (so no
    // inbox wake sweep), and it holds no lease (so reconcile never sees it) —
    // the run sits at 'pending' forever with nothing watching it.
    //
    // We reject rather than silently flipping to 'idle': the caller asked for a
    // run that STARTS, and 'idle' would quietly turn it into one that waits for a
    // message that may never come. Server runtime is message/event-driven by
    // construction (design §3: persona chats), so the honest answer is a 400 that
    // names the two ways out.
    //
    // NO carve-out for goal '<execute>' + planId (M2 re-verification, residual 1).
    // That branch only self-drives in the NON-detached else-branch below, where
    // create() takes the turn in-process under withServerClaim. Under
    // detachedRunsEnabled() — forced true on fly (lib/config.ts) — the same
    // branch goes launchDetached → dispatchRun → (server placement) wakeServerRun,
    // which finds no pending inbox events on a brand-new run and no-ops. The row
    // is then left at 'pending' on a true-server placement: outside every belt
    // (listPendingRunIds skips server rows, no lease for reconcile, not 'parked'
    // for the wake sweep) — exactly the stranded ghost this check exists to
    // prevent, and undetectable in dev where the in-process branch runs instead.
    // The Discord persona plan needs only '<chat>' (and defer), so the honest
    // answer for every pending-producing goal is the same clear 400.
    if (initialStatus === "pending") {
      throw new repo.RepoError(
        `runtime='server' cannot start goal '${goal}': an in-process run has no worker tier to ` +
          `dispatch a kickoff turn to, and the row would sit at status 'pending' with nothing to ` +
          `drive it. Server runtime supports message- and event-driven goals only — use ` +
          `goal '<chat>'/'<plan>', pass defer: true and send the run a message, or create the run ` +
          `with runtime 'worker'.`,
        400
      );
    }
    const unsafe = serverUnsafeProfiles(toolsProfile);
    if (unsafe.length > 0) {
      throw new repo.RepoError(
        `runtime='server' refuses tools profile '${toolsProfile}': ${unsafe.join(", ")} ` +
          `${unsafe.length === 1 ? "is" : "are"} not server-safe (shell/filesystem/repo-write capable, or unknown). ` +
          `A server-runtime run executes inside the orchestrator process; only tool-mediated ` +
          `orchestration profiles may run there (${listServerSafeProfiles().join(", ")}). ` +
          `Ask the persona to spawn a containerized worker run for repo work instead.`,
        400
      );
    }
  }

  // Resolve repo: explicit > task's repo > plan's first repo > defaultRepo.
  // We don't error on missing repo at create time for chat-style runs; the
  // cwd resolver falls back to the orchestrator checkout.
  let repoId: string | null = input.repoId ?? null;
  if (!repoId && input.taskId) {
    const t = await repo.getTask(input.taskId);
    if (t?.repoId) repoId = t.repoId;
  }
  if (!repoId && input.planId) {
    const p = await repo.getPlan(input.planId);
    if (p?.repos.length) repoId = p.repos[0].id;
  }
  if (!repoId && goal === "<chat>") {
    repoId = await repo.defaultRepoId();
  }

  if (repoId && !(await repo.getRepository(repoId))) {
    throw new repo.RepoError(`Repository ${repoId} not found`, 404);
  }
  if (input.taskId && !(await repo.getTask(input.taskId))) {
    throw new repo.RepoError(`Task ${input.taskId} not found`, 404);
  }
  if (input.planId && !(await repo.getPlan(input.planId))) {
    throw new repo.RepoError(`Plan ${input.planId} not found`, 404);
  }
  if (!input.defer && goal === "<execute>" && !input.planId) {
    throw new repo.RepoError(
      "Plan-executor runs (goal=<execute>) require a planId.",
      400
    );
  }
  // Validate the worktree invariants BEFORE inserting the row. Doing this after
  // the insert (the old behaviour) returned the intended 400 but left an
  // undriveable 'pending' ghost run behind (kickoff never starts; neither
  // reaper covers it). Mirror the <execute> planId check above.
  if (!input.defer && goal !== "<chat>" && cwdStrategy === "worktree" && !input.taskId) {
    throw new repo.RepoError(
      "Worktree runs require a taskId (the engine creates a branch and PR for the task).",
      400
    );
  }
  if (!input.defer && cwdStrategy === "worktree_at_pr" && !input.prUrl) {
    throw new repo.RepoError(
      "cwd_strategy=worktree_at_pr requires a prUrl (the worktree is created from the PR's head ref).",
      400
    );
  }

  // Resolve the effective model. The run-agent dialog / chat composers may
  // explicitly emit "provider/model-id"; model-id itself may contain slashes,
  // e.g. OpenRouter ids. When omitted, use the persona's model default. We
  // persist the resolved value so the UI shows what was used.
  const personaId = input.personaId ?? "implementor";
  const persona = await repo.getPersona(personaId);
  if (!persona) {
    // persona_id is a foreign key; surface a clear 404 instead of letting the
    // insert fail with an opaque "FOREIGN KEY constraint failed".
    throw new repo.RepoError(`Persona '${personaId}' not found`, 404);
  }
  const personaModel = `${persona.modelProvider}/${persona.modelId}`;
  const effectiveModel = input.model ?? personaModel ?? DEFAULT_MODEL;

  // Per-run backend choice. Chat runs execute in the full worker harness now
  // (the lightweight in-process/postgres tier was retired), so they support
  // both backends just like every other run kind — no chat-specific pinning.
  // An explicit pick normalizes/validates eagerly; null falls through to the
  // persona's backend default (if set), then the deployment default at turn
  // time. An explicit or persona-inherited 'claude' selection is additionally
  // checked against the model's provider — the Claude backend is Anthropic-only,
  // and that combination can never run.
  let backend: "pi" | "claude" | null = null;
  const requestedBackend = input.backend;
  const validateClaudeProvider = () => {
    const { provider } = parseProviderQualifiedModel(effectiveModel);
    if (backend === "claude" && provider !== "anthropic") {
      throw new repo.RepoError(
        `The 'claude' backend only supports Anthropic models, but the run's model is '${effectiveModel}'. ` +
          `Pick an anthropic/* model or the 'pi' backend.`,
        400
      );
    }
  };
  if (requestedBackend != null) {
    try {
      backend = resolveBackendId(requestedBackend);
    } catch (err) {
      throw new repo.RepoError(err instanceof Error ? err.message : String(err), 400);
    }
    validateClaudeProvider();
  } else if (persona.backend) {
    // No per-run pick: inherit the persona's engine default when set. Validate
    // it the same way as an explicit pick so a misconfigured persona surfaces
    // here rather than at turn time.
    try {
      backend = resolveBackendId(persona.backend);
    } catch (err) {
      throw new repo.RepoError(err instanceof Error ? err.message : String(err), 400);
    }
    validateClaudeProvider();
  }

  // Tree limits (Decision 2): reject BEFORE inserting, same reasoning as the
  // worktree-invariant checks above — validating after the insert would leave an
  // undriveable ghost row behind. Only applies to child runs; a root run (no
  // parentRunId) has no tree to bound.
  if (input.parentRunId != null) {
    const violation = await evaluateTreeLimits(input.parentRunId, { extraTreeRuns: 1 });
    if (violation) throw new repo.RepoError(violation, 400);
  }

  // Placement and backend are one persisted decision. In particular, a null
  // backend on a claude-default deployment must not be recorded as a server /
  // postgres run and then resolve to Claude when it wakes. Nullable reads stay
  // supported for legacy rows, whose lightweight predicates resolve the
  // deployment default before selecting a context mode.
  const persistedBackend = resolveBackendId(backend);

  // Server runtime implies the postgres context mode (runOneTurn), which is a
  // pi-only capability: claude-backend throws on contextSource='postgres' and the
  // Claude Agent SDK has no equivalent of the in-process loop. Fail HERE rather
  // than at turn time — a persona whose backend resolves to claude would
  // otherwise create fine, accept messages, and die on every single turn.
  // resolveBackendId already folded in the persona's pick and the deployment
  // default, so this catches "claude-default deployment, backend left null" too.
  if (runtime === "server" && persistedBackend !== "pi") {
    throw new repo.RepoError(
      `runtime='server' requires the 'pi' backend (resolved '${persistedBackend}'): the in-process ` +
        `postgres-turn loop is pi-only — the Claude backend rejects contextSource='postgres'. ` +
        `Set backend: 'pi' on the run or on persona '${personaId}'.`,
      400
    );
  }

  const insertValues = {
    goal,
    taskId: input.taskId ?? null,
    planId: input.planId ?? null,
    repoId,
    parentRunId: input.parentRunId ?? null,
    toolsProfile,
    cwdStrategy,
    // Placement is a per-run property again (design §3): 'worker' (the default,
    // an out-of-process container/Machine) or 'server' (in-process persona
    // turns, internal callers only — see CreateRunInput.runtime).
    runtime,
    model: effectiveModel,
    backend: persistedBackend,
    thinkingLevel: input.thinkingLevel ?? null,
    title: input.title ?? null,
    userId: input.userId ?? null,
    prUrl: input.prUrl ?? null,
    personaId,
    budgetMaxTurns: input.budget?.maxTurns ?? null,
    budgetMaxUsd: input.budget?.maxUsd ?? null,
    budgetMaxSeconds: input.budget?.maxSeconds ?? null,
    status: initialStatus,
    startedAt: new Date(),
  };

  // Implement-style task runs are admitted under a per-task advisory lock:
  // ONE active agent per task, and ONE canonical branch per task. This is the
  // single enforcement point — every creation path (REST /api/runs, the
  // attached-run endpoint, agent.startSession, the spawn tool, auto-launch)
  // funnels through here, so two agents can never work the same task (and
  // therefore the same branch) concurrently. agent.startSession used to hold
  // this same lock around its own check-then-create; that moved here so the
  // lock and the insert commit atomically on one connection (an outer
  // transaction taking the same lock on a second pooled connection would
  // deadlock against this one).
  const isTaskImplement = goal !== "<chat>" && cwdStrategy === "worktree" && !!input.taskId;
  const inserted = isTaskImplement
    ? await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.taskId!}))`);
        const active = await tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.taskId, input.taskId!),
              eq(agentSessions.cwdStrategy, "worktree"),
              sql`${agentSessions.goal} != '<chat>'`,
              notInArray(agentSessions.status, TERMINAL_STATUS_LIST)
            )
          )
          .limit(1);
        if (active.length > 0) {
          throw new repo.RepoError(
            `Task ${input.taskId} already has an active session (#${active[0].id})`,
            409
          );
        }
        await reserveTaskBranch(tx, input.taskId!);
        return await tx.insert(agentSessions).values(insertValues).returning();
      })
    : await db.insert(agentSessions).values(insertValues).returning();
  const run = hydrateRun(inserted[0]);

  // A worktree run with a task is that task's attached session — point
  // `tasks.attached_run_id` at it (for both the kicked-off Agent path and the
  // deferred chat-box path). `ifUnset` means executor-spawned runs only adopt an
  // empty slot. Bare worktree runs (no task, e.g. tests) skip this.
  if (goal !== "<chat>" && cwdStrategy === "worktree" && input.taskId) {
    await repo.attachRunToTask(input.taskId, run.id, { ifUnset: true });
  }

  // These are create()'s *secondary* launches: a background turn the caller did
  // not itself stream (kickoff / review / execute). When TASK_ORCH_DETACHED_RUNS
  // is on, they detach into a per-run worker (dispatchRun) so a web restart can't
  // kill them; when off, they run in-process exactly as before. The caller's OWN
  // streaming turn (POST /messages → append()) always stays in-process even under
  // the flag — that stream IS the caller's turn — so append() is not gated here.
  // run-dispatch imports from this module, so we import it lazily inside each
  // (already async) branch to keep module load order free of an import cycle.

  // Implement-style kickoff: run the first turn through the unified engine
  // (runs.append → branch create → turn → conditional push/PR). Deferred runs
  // (chat box, bare test runs) skip this and wait for the user's first message.
  if (!input.defer && goal !== "<chat>" && cwdStrategy === "worktree") {
    // taskId presence validated before the insert above.
    const task = (await repo.getTask(input.taskId!))!;
    const prompt = input.initialPrompt ?? await buildImplementPrompt(task);
    void (async () => {
      const { detachedRunsEnabled } = await import("./run-dispatch");
      // FIX 7 (M20): the detached worker rebuilds its own prompt via
      // dispatchTurnPrompt, which synthesizes buildImplementPrompt and would
      // drop a custom initialPrompt. launchDetached persists the custom prompt as
      // the run's first user message so dispatchTurnPrompt's backlog replay
      // (reordered to win over the synthesized prompt) uses it.
      if (detachedRunsEnabled()) {
        await launchDetached(run.id, input.initialPrompt, input.parentRunId ?? null);
      } else await kickoffFirstTurn(run.id, prompt, input.baseBranch);
      // Match the <execute> sibling branch's fire-and-forget guard: a rejection
      // from launchDetached/kickoffFirstTurn off this un-awaited IIFE would
      // otherwise surface as an unhandled rejection.
    })().catch(() => {});
  }

  // Review-style runs: spin up a worktree at the PR's head ref and run a
  // single agent turn against it. Requires a prUrl on the run (validated above).
  if (!input.defer && cwdStrategy === "worktree_at_pr") {
    void (async () => {
      const { detachedRunsEnabled } = await import("./run-dispatch");
      // FIX 7 (M20): launchDetached persists a custom initialPrompt as the first
      // user message so the worker's <review> drive can read it back and
      // pass it to runReview (which would otherwise be dispatched with no prompt).
      if (detachedRunsEnabled()) {
        await launchDetached(run.id, input.initialPrompt, input.parentRunId ?? null);
      } else await runReview(run.id, input.prUrl!, input.initialPrompt ?? null);
      // Match the <execute> sibling branch's fire-and-forget guard: a rejection
      // from launchDetached/runReview off this un-awaited IIFE would otherwise
      // surface as an unhandled rejection.
    })().catch(() => {});
  }

  // Plan-executor runs: a single long-running agent that drives a whole plan
  // (implement → review → merge) by spawning child runs. Operates at the repo
  // root (no worktree of its own); children make their own worktrees.
  if (!input.defer && goal === "<execute>" && input.planId) {
    void (async () => {
      const { detachedRunsEnabled } = await import("./run-dispatch");
      // FIX 7 (M20): launchDetached persists a custom initialPrompt as the first
      // user message so the worker's <execute> drive can read it back and
      // pass it to runExecute as operator instructions.
      if (detachedRunsEnabled()) {
        await launchDetached(run.id, input.initialPrompt, input.parentRunId ?? null);
      } else {
        // In-process (non-detached dev): take the server-turn claim so a
        // duplicate wake (an inbox emit racing this create-time turn) can't drive
        // a second coordinator turn concurrently. withServerClaim no-ops the drive
        // if the claim is already held. Match the sibling dispatch branches'
        // fire-and-forget guard: a throw would otherwise surface as an unhandled
        // rejection off this un-awaited IIFE.
        await withServerClaim(run.id, () =>
          runExecute(run.id, input.planId!, input.initialPrompt ?? null)
        ).catch(() => {});
      }
    })();
  }

  return run;
}

/**
 * Shared tail of create()'s three detached launch branches: persist any custom
 * initialPrompt as the run's first user message, then EITHER isolate (park the
 * row for the server to dispatch onto its own Machine) OR dispatch in-process.
 *
 * Isolate (docs/nested-machine-dispatch.md, Decision 1): when this process is a
 * worker AND the nested-dispatch policy is "isolate", we must NOT call
 * dispatchRun. A worker holds no Fly credentials and none of the admission /
 * pending-pump / sweep machinery, so dispatching here falls through to an
 * in-container spawn inside the parent's Machine — exactly the bug this design
 * fixes. Instead we leave the freshly-inserted row at status 'pending' (its
 * initialStatus): that pending row IS the dispatch request. The SERVER's pending
 * pump claims it, runs admission, and provisions the child its own Fly Machine.
 * We also emit a runner_deferred event (Decision 6) so the gap between "tool
 * returned a session id" and "machine created" is visible in the run's event tail.
 *
 * Everywhere else — the SERVER (insideWorker() false), and a worker under the
 * "inline" policy (off-Fly / rollback) — behavior is byte-identical to before:
 * persist the prompt, then dispatchRun.
 */
async function launchDetached(
  runId: number,
  initialPrompt: string | null | undefined,
  parentRunId: number | null
): Promise<void> {
  const { dispatchRun, insideWorker, nestedDispatchMode } = await import("./run-dispatch");
  if (initialPrompt) {
    await persistMessage(runId, "user", [{ type: "text", text: initialPrompt }]);
  }
  if (insideWorker() && nestedDispatchMode() === "isolate") {
    await emitRunnerDeferred(runId, parentRunId);
    return; // row stays 'pending'; the server's pump dispatches it to its own Machine
  }
  void dispatchRun(runId).catch(() => {});
}

/**
 * Observability event marking a worker parking a child at 'pending' for the
 * server to isolate onto its own Machine (docs/nested-machine-dispatch.md,
 * Decision 6). Best-effort: an event-mirror failure must never break the launch.
 */
async function emitRunnerDeferred(runId: number, parentRunId: number | null): Promise<void> {
  try {
    await db.insert(agentEvents).values({
      sessionId: runId,
      type: "runner_deferred",
      payload: JSON.stringify({ parentRunId, reason: "nested_isolate" }),
      createdAt: new Date(),
    });
  } catch {
    // ignore event mirror failures
  }
}


/**
 * Identity fence for a write that follows an out-of-transaction liveness
 * observation: the row may change only while no runner_instances row DISAGREES
 * with the incarnation we observed. Phrased as NOT EXISTS so a claim with no
 * runner instance at all (a server-scoped turn) still passes — EXISTS would
 * silently veto every takeover of such a claim.
 */
function incarnationFence(runId: number, storedIncarnation: string | null | undefined) {
  return sql`NOT EXISTS (SELECT 1 FROM runner_instances ri WHERE ri.run_id = ${runId} AND ri.worker_incarnation IS DISTINCT FROM ${storedIncarnation ?? null})`;
}

/**
 * Park a run at 'pending' as a dispatch request for the SERVER's pump — the
 * worker-side counterpart of dispatchRun for FOLLOW-UP messages, mirroring
 * launchDetached's isolate deferral for child creation (the pending row IS the
 * dispatch request; docs/nested-machine-dispatch.md Decision 1). A worker holds
 * no Fly credentials, so it must never dispatch/resume Machines itself.
 *
 * Guarded single conditional UPDATE: a row with a live claim (workerScope set
 * AND heartbeat fresher than HEARTBEAT_STALE_MS) is left alone — the in-flight
 * turn drains the freshly persisted message, same as dispatchRun's
 * "already-claimed". heartbeatAt is stamped because pumpTick measures the
 * pending episode from it (TASK_ORCH_MAX_DEFER_MS).
 */
export async function deferRunForServerDispatch(
  runId: number,
  parentRunId: number | null
): Promise<boolean> {
  const before = await get(runId);
  const [instance] = await db.select({ incarnation: runnerInstances.workerIncarnation })
    .from(runnerInstances).where(eq(runnerInstances.runId, runId));
  const verdict = before ? (await resolveLiveness(runId)).verdict : "unowned";
  // Never park a run whose worker may still be alive (unknown is not permission).
  if (!before || verdict === "alive" || verdict === "unknown") return false;
  const parked = await db.update(agentSessions)
    .set({ status: "pending", pendingSince: new Date(), workerScope: null })
    .where(and(
      eq(agentSessions.id, runId),
      notInArray(agentSessions.status, HARD_TERMINAL_STATUSES),
      before.workerScope == null
        ? isNull(agentSessions.workerScope)
        : and(
            eq(agentSessions.workerScope, before.workerScope),
            incarnationFence(runId, instance?.incarnation ?? null)
          )
    ))
    .returning({ id: agentSessions.id });
  if (parked.length === 0) return false;
  await emitRunnerDeferred(runId, parentRunId);
  return true;
}

export async function list(filter: ListFilter = {}): Promise<RunRow[]> {
  const conditions = [];
  if (filter.goal) conditions.push(eq(agentSessions.goal, filter.goal));
  if (filter.status) {
    if (Array.isArray(filter.status)) {
      conditions.push(inArray(agentSessions.status, filter.status));
    } else {
      conditions.push(eq(agentSessions.status, filter.status));
    }
  }
  if (filter.taskId === null) {
    conditions.push(isNull(agentSessions.taskId));
  } else if (filter.taskId !== undefined) {
    conditions.push(eq(agentSessions.taskId, filter.taskId));
  }
  if (filter.planId === null) {
    conditions.push(isNull(agentSessions.planId));
  } else if (filter.planId !== undefined) {
    conditions.push(eq(agentSessions.planId, filter.planId));
  }
  if (filter.userId === null) {
    conditions.push(isNull(agentSessions.userId));
  } else if (filter.userId !== undefined) {
    conditions.push(eq(agentSessions.userId, filter.userId));
  }
  if (filter.repoId) conditions.push(eq(agentSessions.repoId, filter.repoId));
  if (filter.parentRunId) conditions.push(eq(agentSessions.parentRunId, filter.parentRunId));
  if (filter.activeOnly) {
    conditions.push(notInArray(agentSessions.status, TERMINAL_STATUS_LIST));
  }
  const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
  let q = db.select().from(agentSessions).orderBy(desc(agentSessions.startedAt)).$dynamic();
  if (where) q = q.where(where);
  if (filter.limit !== undefined) q = q.limit(filter.limit);
  const rows = await q;
  return rows.map(hydrateRun);
}

const TERMINAL_STATUS_LIST: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

export async function get(id: number): Promise<RunRow | null> {
  return (await runTransport()).getRun(id);
}

export async function listMessages(runId: number): Promise<MessageRow[]> {
  return (await runTransport()).listMessages(runId);
}

/**
 * Snapshot the current max agent_messages / agent_events ids for a run. The run
 * page renders the conversation up to this point, then seeds the read-only SSE
 * tail (lib/run-stream) with this cursor so the stream forwards only rows
 * written AFTER the snapshot — no duplicate replay of the already-rendered
 * history, and no gap either (the tail resumes exactly here).
 */
export async function streamCursor(runId: number): Promise<{ msgId: number; evtId: number }> {
  const m = (
    await db
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(desc(agentMessages.id))
      .limit(1)
  )[0];
  const e = (
    await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(eq(agentEvents.sessionId, runId))
      .orderBy(desc(agentEvents.id))
      .limit(1)
  )[0];
  return { msgId: m?.id ?? 0, evtId: e?.id ?? 0 };
}

// ──────────────────────────────────────────────────────────
// append / cancel / close
// ──────────────────────────────────────────────────────────

/**
 * Append a user/system message to a run and (if the run was idle) resume
 * the SDK session, streaming events back. Only one append may run at a time
 * per runId; concurrent calls queue on the per-run lock.
 */
export async function* append(input: AppendInput): AsyncGenerator<AppendStreamEvent> {
  const lock = getLock(input.runId);
  // Wait for any in-flight append to finish before claiming the slot.
  while (lock.busy) {
    try {
      await lock.busy;
    } catch {
      // Prior turn errored; we still take the slot.
    }
  }
  let release!: () => void;
  let rejectRelease!: (err: unknown) => void;
  lock.busy = new Promise<void>((res, rej) => {
    release = res;
    rejectRelease = rej;
  });
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  // Whether THIS append created the in-process runner. Guards the finally so an
  // early-return reject path (run missing / already in flight / terminal) never
  // deletes a runner owned by another worker (runReview/runExecute/followUp).
  let ownsRunner = false;
  // The server-turn claim THIS append took (residual 2, below), if any. Released
  // — and its 'preparing' stamp rolled back if the turn never got going — in the
  // finally, exactly like withServerClaim does for the wake path.
  let serverScope: string | null = null;
  let serverPrevStatus: SessionStatus | null = null;

  try {
    let run = await get(input.runId);
    if (!run) {
      yield { type: "error", error: `Run ${input.runId} not found` };
      return;
    }
    // A dispatched worker adopting the `preparing` claim it just received (see
    // AppendInput.takeover) is the legitimate owner, not a competing turn — the
    // fresh heartbeat that dispatchRun set is its own. Honor takeover only for
    // `preparing`; a `running` lease still means a real turn is underway.
    const adoptingOwnClaim = input.takeover === true && run.status === "preparing";
    const liveness = await resolveLiveness(input.runId);
    if (runners.has(input.runId) || (liveness.verdict === "alive" && !adoptingOwnClaim)) {
      // A live turn is in flight and must not be double-driven:
      //   • runners.has → an in-process runner exists (append/runReview/
      //     runExecute/followUp is mid-turn in THIS process). The per-run lock
      //     covers concurrent appends, but the review/execute/follow-up workers
      //     don't take that lock, so this guards against them directly.
      //   • isLeaseLive → an active status with a fresh heartbeat, i.e. a turn
      //     genuinely in flight in ANOTHER process.
      // A run in an active status with a STALE heartbeat (and no local runner)
      // is an orphan whose owner crashed, so we fall through and take it over
      // instead of rejecting forever.
      yield {
        type: "error",
        error: `Run ${input.runId} is already in flight (status=${run.status}).`,
      };
      return;
    }
    // A worktree run (the task's attached session) is resumable even after it
    // lands `completed`/`failed`: prepareCwd re-materializes the worktree on its
    // branch. A plan-executor run is resumable too — its state is durable task
    // rows, not a worktree (isResumableRun). Only `cancelled`/`closed` are hard
    // stops. Chat/none runs keep idle-only resume.
    if (
      isTerminalStatus(run.status) &&
      run.status !== "idle" &&
      !(run.goal === "<chat>" && run.status === "completed") &&
      !isResumableRun(run)
    ) {
      const why =
        run.status === "closed"
          ? "is closed; fork it to continue"
          : `is in terminal status '${run.status}'; cannot resume`;
      yield { type: "error", error: `Run ${input.runId} ${why}.` };
      return;
    }

    // ── Server-runtime turns take the SAME single-owner claim the wake path
    // takes (M2 re-verification, residual 2). The guard above is a SNAPSHOT: a
    // pipe user-message append can read the run as 'idle' with no worker_scope,
    // pass it, and only then start writing — while in the web process an inbox
    // wake's claimServerTurn CAS succeeds against that same still-idle row. Both
    // then drive an in-process postgres turn and interleave agent_messages into
    // one conversation. Nothing above serializes them: a server row holds no
    // worker claim of its own, the per-run lock is in-process only, and 'idle' is
    // not a lease status so isLeaseLive is false for both.
    //
    // So: claim BEFORE the first write, with the same CAS on the same columns
    // (worker_scope 'server-<nonce>' + heartbeat) — whoever wins drives, and the
    // loser gets today's "already in flight" rejection VERBATIM, from before any
    // mutation (no persisted user row, no status change), which is the contract
    // lib/pipe/agent-loop.ts already handles: an `error` frame finalizes the draft
    // with "⚠️ …" and the per-conversation queue moves on to the next message
    // instead of wedging.
    //
    // Skipped for `takeover` (wakeServerRun / a dispatched worker already HOLDS
    // the claim it made for this call — re-claiming would deadlock against
    // ourselves) and for every worker-runtime / demoted-legacy row, which reach
    // this line on exactly the path they did before.
    if (isServerRuntimeRun(run) && input.takeover !== true) {
      const claim = await claimServerTurn(input.runId, { takeoverStale: true });
      if (!claim.claimed) {
        yield {
          type: "error",
          error: `Run ${input.runId} is already in flight (status=${run.status}).`,
        };
        return;
      }
      serverScope = claim.scope;
      serverPrevStatus = claim.previousStatus;
    }

    // persistUser===false: the server already inserted this user message (to fire
    // run_input and wake this worker), so re-inserting would duplicate the row and
    // re-stream the user_message frame the server already relayed. Skip both.
    if (input.persistUser !== false) {
      const userMsg = await persistMessage(run.id, input.role === "system" ? "system" : "user", [
        { type: "text", text: input.text },
      ]);
      yield { type: "user_message", message: userMsg };
    }

    // Event system: fresh-turn bookkeeping (docs/agent-events.md §4.3, §6.1).
    // Resuming a run that sits in a terminal-but-resumable state (a completed
    // implement child being re-driven via append_message) starts a new rework
    // ATTEMPT. Every new turn also clears last turn's `result` (a stale report
    // must not masquerade as this turn's result) and `park_reason` (fresh turn
    // = fresh intent). Note 'parked' itself needs no special-casing in the
    // status gates above: it is non-terminal, so a parked run is appendable
    // exactly like 'idle' — a human/agent message wakes it.
    const resumesTerminalAttempt = isTerminalStatus(run.status) && isResumableRun(run);
    await (await runTransport()).patchRun(run.id, {
      result: null,
      parkReason: null,
      incrementAttempt: resumesTerminalAttempt,
    });

    await setStatus(run.id, "running");

    // Register the abort handle and bus BEFORE the (seconds-long) worktree prep.
    // If we waited until after prepareCwd (the old behaviour), a cancel()/
    // interrupt()/close() landing during `git worktree add` would find no runner
    // and fail to abort — the turn would then run to completion and its final
    // update would resurrect a row the user already cancelled.
    const author = input.author ?? authorFor(run);
    const abort = input.abort ?? new AbortController();
    const bus = new EventEmitter();
    registerRunner(run.id, { abort, bus });
    ownsRunner = true;

    // Open the liveness lease and keep it fresh for the whole active period
    // (prepare → turn → push/PR). The interval ticks even while a slow model or
    // tool call is awaited, so a long-but-alive turn is never mistaken for an
    // orphan. It also polls the cross-process cancel flag so a detached worker
    // aborts when cancel() flips cancel_requested. Cleared in the finally below.
    heartbeat = startCancelPoll(input.runId, abort);

    // First turn of a worktree run: create its branch + worktree. On later
    // turns this is a no-op and prepareCwd re-materializes a missing worktree
    // (server restarts / `git worktree prune` kill the directory; the branch
    // survives, so we recreate it).
    let cwd: string;
    try {
      const runForBranch = run;
      run = await timeRunnerPhase(
        "worktree_branch",
        () => ensureWorktreeBranch(runForBranch, input.baseBranch),
        { provider: runnerProviderLabel(), fields: { runId: runForBranch.id, cwdStrategy: runForBranch.cwdStrategy } }
      );
      const runForPrepare = run;
      cwd = await timeRunnerPhase(
        "worktree_prepare",
        () => prepareCwd(runForPrepare),
        { provider: runnerProviderLabel(), fields: { runId: runForPrepare.id, cwdStrategy: runForPrepare.cwdStrategy } }
      );
    } catch (err) {
      if (abort.signal.aborted) {
        // cancel()/interrupt()/close() fired during prep; respect their row.
        await repairAbortedRun(input.runId);
        yield { type: "done" };
        return;
      }
      const msg = describe(err);
      await setError(run.id, msg);
      yield { type: "error", error: msg };
      return;
    }

    // A cancel()/close() that landed during prep already wrote a terminal row
    // (and cancel() removed the worktree). Bail before spending a full model
    // turn on a run the user already stopped.
    if (abort.signal.aborted) {
      await repairAbortedRun(input.runId);
      yield { type: "done" };
      return;
    }

    // Digest injection (§6.4): claim pending inbox events under the per-run
    // lock and weave the digest into this turn's prompt (as late as possible —
    // after prep — to shrink the claimed-but-turn-failed window). Best-effort:
    // an inbox hiccup must never block the user's turn.
    let effectivePrompt = input.text;
    try {
      const digest = await (await runTransport()).claimInboxDigest(run.id);
      if (digest) effectivePrompt = `${digest}\n\n${input.text}`;
    } catch {
      // pump sweep / next turn retries pending events
    }

    // A chat drives through runOneTurn like every other run: the while-loop
    // below (single iteration for a chat — not an implement worktree) lands
    // 'idle'/'parked' through the same finalize.
    let promptForTurn = effectivePrompt;
    let result: TurnResult | null = null;
    let prUrlUpdate = run.prUrl;
    let observedPrUrl = run.prUrl;
    let nextStatus: SessionStatus = "idle";
    let turnEnd: Awaited<ReturnType<typeof readTurnEndState>> | null = null;
    let outcomeUpdate = run.outcome;
    // How many times this append() has re-prompted the agent to keep going
    // because an implement-worktree turn ended without a PR. Bounded by
    // MAX_PR_CONTINUATIONS so the loop can't spin forever (see the guard below).
    let prContinuations = 0;

    while (true) {
      // Fresh turn = fresh tool intent. Without this, a prior report_result()
      // without a PR would keep steering every continuation to the same stale
      // result instead of letting the agent correct course.
      await (await runTransport()).patchRun(run.id, { result: null, parkReason: null });

      try {
        result = await runOneTurn({
          run,
          cwd,
          prompt: promptForTurn,
          rawUserText: input.text,
          inputMessageId: input.inputMessageId,
          abort,
          author,
          // Event-wake turns pass an ephemeral prompt (the digest is injected as
          // context, not persisted as a user row) — postgres mode must not rewrite
          // a user row to embed it.
          ephemeralInput: input.ephemeralInput === true,
          // Only the FIRST turn of this append recalls memory against the user's
          // message; the continuation re-prompts below are orchestrator text and
          // must not re-inject the same recalled block every iteration.
          suppressRecall: prContinuations > 0,
          onSdk: (m) => {
            // forward to in-process bus consumers (SSE for /sessions UI)
            bus.emit("event", { type: "sdk", sdk: m });
          },
        });
      } catch (err) {
        if (abort.signal.aborted) {
          // Aborted mid-turn. cancel()/interrupt()/close() rewrote the row; a bare
          // client-disconnect (req.signal → input.abort) did not — repair the
          // stranded 'running' row so it doesn't look in-flight forever.
          await repairAbortedRun(input.runId);
          yield { type: "done" };
          return;
        }
        const msg = describe(err);
        await setError(run.id, msg);
        yield { type: "error", error: msg };
        return;
      }

      // The turn resolved normally but the signal may have aborted right at the
      // end (backend swallowed it). Respect any terminal row the aborter wrote /
      // repair a stranded lease instead of overwriting it below.
      if (abort.signal.aborted) {
        await repairAbortedRun(input.runId);
        yield { type: "done" };
        return;
      }

      // Forward streamed SDK envelopes to the caller. We accumulated them in
      // the turn helper rather than yielding live so the per-message persistence
      // and the SSE stream see the same sequence.
      for (const env of result.envelopes) {
        // Persisted envelopes carry their DB row so the client can dedup this
        // frame against the same row arriving over the read-only /events tail.
        yield { type: "sdk", sdk: env, message: result.persisted.get(env) };
      }

      // Worktree runs sync git after each turn: if the branch gained commits,
      // push them (updating the PR) and open a PR the first time round. A no-op
      // for chat-only turns (no commits) and for non-worktree runs.
      if (isImplementWorktree(run)) {
        try {
          prUrlUpdate = await gitSyncAfterTurn(run, cwd, result.summary, input.baseBranch);
        } catch (err) {
          await persistMessage(run.id, "system", [
            { type: "text", text: `Push/PR sync failed: ${describe(err)}` },
          ]);
        }
      }

      // Worktree runs now require a PR before a success landing. If the agent
      // cannot fulfill the task, it can call raise() or report_result(status:
      // "failed"|"blocked") to land failed instead of continuing.
      const budgetHit = checkBudget(run, result);
      const landsCompleted = isImplementWorktree(run);
      turnEnd = await readTurnEndState(run.id);
      observedPrUrl = resultPrUrl(turnEnd.result) ?? prUrlUpdate;
      if (landsCompleted && !observedPrUrl && run.taskId) {
        const task = await (await runTransport()).getTask(run.taskId);
        observedPrUrl = task?.prUrl ?? null;
      }
      nextStatus = decideTurnEndStatus({
        goal: run.goal,
        freshStatus: turnEnd.status,
        parkReason: turnEnd.parkReason,
        result: turnEnd.result,
        budgetHit,
        defaultStatus: landsCompleted ? "completed" : "idle",
        requiresPrUrl: landsCompleted,
        prUrl: observedPrUrl,
      });
      // Review-style runs surface a structured verdict in `outcome`. Gated on
      // goal so chat/implement append flows are unaffected.
      outcomeUpdate =
        run.goal === "<review>"
          ? extractReviewOutcome(result.summary) ?? run.outcome
          : run.outcome;

      if (isImplementWorktree(run) && nextStatus === "running") {
        prContinuations += 1;
        const capHit = prContinuations >= MAX_PR_CONTINUATIONS;
        // The agent believes it finished (a non-failed report_result) but no PR
        // exists — or the continuation budget is spent. Either way the model's
        // part is over: SALVAGE mechanically. Commit whatever is left in the
        // tree, push, and open the PR from what's on the branch, then re-decide
        // the landing with the salvaged PR. A silent turn end (no result, cap
        // not hit) skips salvage — the agent gets re-prompted below instead, so
        // half-done work isn't prematurely wrapped into a PR.
        const claimedDone = turnEnd.result != null && !isFailedResult(turnEnd.result);
        if (claimedDone || capHit) {
          try {
            const salvaged = await gitSyncAfterTurn(run, cwd, result.summary, input.baseBranch, {
              commitLeftovers: true,
            });
            if (salvaged) {
              prUrlUpdate = salvaged;
              observedPrUrl = salvaged;
              await persistMessage(run.id, "system", [
                {
                  type: "text",
                  text: `The worker pushed the branch and ensured a PR exists from the work left on it: ${salvaged}`,
                },
              ]);
              nextStatus = decideTurnEndStatus({
                goal: run.goal,
                freshStatus: turnEnd.status,
                parkReason: turnEnd.parkReason,
                result: turnEnd.result,
                budgetHit,
                defaultStatus: "completed",
                requiresPrUrl: true,
                prUrl: observedPrUrl,
              });
              break;
            }
          } catch (err) {
            await persistMessage(run.id, "system", [
              { type: "text", text: `Salvage push/PR failed: ${describe(err)}` },
            ]);
          }
        }
        // Safety stop: the agent has ended this many turns without ever getting
        // a PR onto the task (and salvage found nothing to ship). Rather than
        // re-prompt forever, land 'failed' with a structured result so the run
        // is observable and resumable like any other failure instead of
        // spinning invisibly.
        if (capHit) {
          await (await runTransport()).patchRun(run.id, {
            result: prContinuationFailureResult(
              prContinuations,
              MAX_PR_CONTINUATIONS,
              new Date().toISOString()
            ),
          });
          await persistMessage(run.id, "system", [
            {
              type: "text",
              text:
                `Reached the ${MAX_PR_CONTINUATIONS}-turn limit for producing a PR without ` +
                "success; landing this run as failed to avoid an infinite loop. Resume the run " +
                "to keep working, or raise TASK_ORCH_MAX_PR_CONTINUATIONS.",
            },
          ]);
          nextStatus = "failed";
          break;
        }
        await persistMessage(run.id, "system", [
          {
            type: "text",
            text:
              "The previous turn ended without a PR on the task. Continue working on this same branch. " +
              "If the task cannot be fulfilled, call raise({ code, message, recoverable, details }) or " +
              "report_result({ status: \"failed\", summary }).",
          },
        ]);
        promptForTurn =
          "Continue the same task. Do not stop after investigation or partial edits. " +
          "Commit all intended changes with a clear message — the orchestrator then pushes the branch, " +
          "opens or updates the PR, and records it on the task. When your work is committed, " +
          "report_result({ status: \"success\", summary }). " +
          "If you cannot fulfill the task, call raise({ code, message, recoverable, details }) or " +
          "report_result({ status: \"failed\", summary }) and end.";
        run = (await get(run.id)) ?? run;
        continue;
      }

      break;
    }

    if (!result || !turnEnd) {
      await setError(run.id, "Turn ended without producing a result.");
      yield { type: "error", error: "Turn ended without producing a result." };
      return;
    }

    // THE incident site: the turn-end landing (status column + paired event)
    // must be one transaction so a connection death between them can't strand a
    // finished run in a lease status for the reaper to mislabel as failed.
    // applyStatusTx also fires the live-bus emit (BEFORE the finally drops the
    // runner) and the child lifecycle event, only when the row actually wrote.
    // Guard: keep THIS site's own CAS (notInArray cancelled/closed) rather than
    // the generic terminal no-op guard — nextStatus here may itself be
    // non-terminal (parked/idle on a resuming chat turn), and this CAS already
    // stops a cancel()/close() that raced the turn end from being resurrected.
    // Retries: the worker is about to exit, so a transient
    // DB blip re-acknowledges the atomic, guarded finalize a few times.
    await (await runTransport()).applyStatus(run.id, nextStatus, {
      set: {
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
        outcome: outcomeUpdate,
        prUrl: observedPrUrl ?? prUrlUpdate,
        // Keep park_reason only when actually parking; clear a stale one that
        // lost to a result/budget landing. Parked is non-terminal: no completedAt.
        parkReason: nextStatus === "parked" ? turnEnd.parkReason : null,
        completedAt: isTerminalStatus(nextStatus) ? new Date() : null,
      },
      guard: "not-cancelled-closed",
      retries: FINALIZE_RETRIES,
    });

    // Sprites: close the proxy channel when the run leaves the active states
    // (idle/parked/terminal). An open tunnel is activity and prevents hibernation.
    if (["idle", "parked", "completed", "failed", "cancelled", "closed", "budget_exhausted"].includes(nextStatus)) {
      void import("./worker-channel/registry").then((m) => m.maybeCloseSpritesChannel(run.id).catch(() => undefined));
    }

    yield { type: "done" };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Drop the in-process runner on every exit path (success, error, abort) —
    // but only if THIS append created it. Leaving it set would make the guard
    // above reject the next message with a false "already in flight".
    if (ownsRunner) runners.delete(input.runId);
    // Release the server-turn claim this append took, on every exit path
    // (success, error, abort, or a consumer abandoning the generator) — the same
    // finally-release discipline withServerClaim applies to the wake path. The
    // restore is guarded on (still 'preparing' AND still our scope), so it only
    // fires when the turn never advanced past the claim; a landed turn's status
    // is left exactly as it wrote it. Best-effort: a DB blip here must not mask
    // the turn's own outcome (the stale-heartbeat takeover above, and reconcile,
    // both recover a scope that failed to release).
    if (serverScope) {
      const scope = serverScope;
      try {
        await restoreClaimedStatus(input.runId, scope, serverPrevStatus);
      } catch {
        // fall through to the release
      }
      try {
        await releaseServerTurn(input.runId, scope);
      } catch {
        // reconcile / the stale-claim takeover recover this
      }
    }
    release();
    lock.busy = null;
    // Make eslint happy about unused binder; actually exposed above as fallback.
    void rejectRelease;
  }
}

/**
 * FIX 1 (M4): enumerate the non-terminal descendant runs of a plan-executor-style
 * parent — rows whose parent_run_id chains back to `rootId` (children, and one
 * more level of grandchildren). Recurses breadth-first with a visited-set and a
 * depth bound so a self-referential / cyclic parent_run_id graph can't loop
 * forever. We recurse THROUGH terminal nodes (a terminal child may still own a
 * live grandchild) but only RETURN the non-terminal ones — the runs a cascade
 * cancel actually needs to stop.
 */
async function collectActiveDescendants(rootId: number): Promise<RunRow[]> {
  const found: RunRow[] = [];
  const visited = new Set<number>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
    const children = await db
      .select()
      .from(agentSessions)
      .where(inArray(agentSessions.parentRunId, frontier));
    const next: number[] = [];
    for (const row of children) {
      if (visited.has(row.id)) continue; // self-reference / cycle guard
      visited.add(row.id);
      const child = hydrateRun(row);
      next.push(child.id);
      if (!isTerminalStatus(child.status)) found.push(child);
    }
    frontier = next;
  }
  return found;
}

export async function cancel(id: number): Promise<RunRow> {
  const run = await get(id);
  if (!run) throw new repo.RepoError(`Run ${id} not found`, 404);
  if (isTerminalStatus(run.status)) return run;
  const runner = runners.get(id);
  runner?.abort.abort();
  // Cross-process cancel: a detached worker (TASK_ORCH_DETACHED_RUNS) runs in
  // its own process and can't see the in-process AbortController above, so we
  // also signal through the DB. The worker polls isCancelRequested() at
  // heartbeat cadence and aborts its own turn. Harmless for in-process runs —
  // they already aborted synchronously, so the poll is a no-op there.
  // Atomic status+event with the terminal no-op guard: a concurrent double-cancel
  // that raced past the early-return above matches 0 rows and emits no second
  // event. applyStatusTx also fires the parent's terminal child event on a write.
  await applyStatusTx(id, "cancelled", {
    set: { completedAt: new Date(), cancelRequested: 1 },
    guard: notInArray(agentSessions.status, TERMINAL_STATUSES),
  });
  // Worker-channel cancel bridge (section 8.4): a channel worker neither polls
  // the DB nor sees this process's AbortController — push run.cancel so its
  // in-flight model turn aborts now rather than at provider hard-stop.
  void bridgeToChannel(id, "run.cancel", {
    reason: "user cancel",
    requestId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    deadline: null,
  } as Record<string, unknown>);
  // Event system (§6.6): mirror the cancel as a CONTROL-class inbox row — the
  // model can never claim/swallow it; enforcement stays platform-side (the
  // heartbeat poll aborts and then markControlInjected acknowledges the row).
  void emitInboxEvent({
    targetRunId: id,
    type: "run.cancel_requested",
    sourceKind: "system",
    sourceId: String(id),
    dedupeKey: `cancel:${id}`,
    payload: { run_id: id },
    noWake: true,
  }).catch(() => {});
  closeBus(id);
  // Hard-stop the detached worker as a fallback (the cancel_requested poll aborts
  // it gracefully within a heartbeat; provider stop is the belt). No-op if gone.
  // .catch: stopRunner is fire-and-forget here; a provider hiccup must not surface
  // as an unhandled rejection.
  void runDispatch.stopRunner(run.workerScope).catch(() => {});
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, await repoRoot(run)).catch(() => {});
  }
  // FIX 1 (M4): cascade the cancel to in-flight descendant runs. A plan-executor
  // run spawns child runs (parent_run_id = executor id, possibly one level
  // deeper); cancelling only the executor would leave those children running,
  // spending, and pushing. cancel() each non-terminal descendant. The target row
  // is already terminal by now, so its own cancel is idempotent — nested cancels
  // early-return on terminal status, so this converges (no infinite recursion).
  for (const child of await collectActiveDescendants(id)) {
    if (child.id === id) continue; // self-reference guard (belt for the visited-set)
    await cancel(child.id).catch(() => {});
  }
  return (await get(id))!;
}

/**
 * Soft-stop the in-flight turn of a run and return it to `idle` so the
 * conversation can keep going. This is the interactive counterpart to cancel():
 * where cancel() lands the run in the terminal `cancelled` state (revivable only
 * by forking), interrupt() just halts the current turn while keeping the run —
 * and its SDK session, worktree, and history — alive. That's what an interactive
 * `/stop` wants: stop what the agent is doing, then keep talking with full
 * context.
 *
 * Returns true if a turn was actually in flight and got aborted, false if the
 * run was idle or missing (nothing to stop). The aborted append's own cleanup
 * returns early without resetting the row from `running` (see the abort branch
 * in append()), so we flip the status back to `idle` here.
 */
export async function interrupt(id: number): Promise<boolean> {
  const run = await get(id);
  if (!run) return false;
  const runner = runners.get(id);
  if (!runner) return false; // nothing in flight
  runner.abort.abort();
  // Keep the worktree intact (no cleanupWorktree) so the next message resumes
  // instantly. Clear completedAt: an idle run is mid-conversation, not finished.
  // Guard on a non-terminal status (mirror cancel()): a cancel()/close() that
  // raced this /stop already landed the row terminal — flipping it back to 'idle'
  // here would resurrect a cancelled/closed run. The guard matches 0 rows in that
  // case (no write, no event), leaving the terminal landing intact.
  await applyStatusTx(id, "idle", {
    set: { completedAt: null },
    guard: notInArray(agentSessions.status, TERMINAL_STATUSES),
  });
  return true;
}

/** What `/model` and `/budget` in the terminal cockpit set on a live run
 *  (tui T-tui-12). An omitted field is left alone; an explicit null clears the
 *  cap so the run falls back to its persona / deployment default. */
export interface RunConfigPatch {
  model?: string | null;
  budgetMaxUsd?: number | null;
  budgetMaxTurns?: number | null;
}

/**
 * Retune a run in place. Deliberately a plain UPDATE and not applyStatusTx:
 * nothing here is a state transition, so there is no paired status event to
 * write and no terminal guard to respect — a parked or finished run may still
 * be retuned, and the next turn (a resume) picks the new values up when it
 * reads the row. checkBudget() reads budget_max_* per turn, so a tightened cap
 * bites at the end of the turn that is already in flight.
 */
export async function configure(id: number, patch: RunConfigPatch): Promise<RunRow> {
  const run = await get(id);
  if (!run) throw new repo.RepoError(`Run ${id} not found`, 404);
  const set: Partial<typeof agentSessions.$inferInsert> = {};
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.budgetMaxUsd !== undefined) set.budgetMaxUsd = patch.budgetMaxUsd;
  if (patch.budgetMaxTurns !== undefined) set.budgetMaxTurns = patch.budgetMaxTurns;
  // An empty patch is a no-op rather than an error: the caller already got
  // what it asked for, and an UPDATE with no columns is a SQL error.
  if (Object.keys(set).length === 0) return run;
  await db.update(agentSessions).set(set).where(eq(agentSessions.id, id));
  return (await get(id)) ?? run;
}

export async function close(id: number): Promise<RunRow> {
  const run = await get(id);
  if (!run) throw new repo.RepoError(`Run ${id} not found`, 404);
  if (run.status === "closed") return run;
  // If a turn is in flight, cancel it first.
  const runner = runners.get(id);
  if (runner) runner.abort.abort();
  // Cross-process stop, same as cancel(): the in-process abort above can't reach a
  // detached worker in its own container, so also set cancel_requested (the worker
  // polls it at heartbeat cadence and aborts its turn) and hard-stop the runner as
  // the belt. Without this, closing a run in the containerized deploy leaves the
  // worker's turn burning tokens to completion.
  //
  // Route through applyStatusTx (not a bare UPDATE): it writes the status column
  // AND the paired 'closed' status event in ONE transaction, so readStreamSince /
  // the SSE relays actually see a terminal frame (a bare UPDATE emitted none, so
  // relays hung until timeout) and any pending run-timers are cancelled in the
  // same tx. The terminal no-op guard makes close() idempotent and stops it from
  // clobbering a run another path already landed terminal (e.g. a raced cancel()).
  await applyStatusTx(id, "closed", {
    set: { completedAt: new Date(), cancelRequested: 1 },
    guard: notInArray(agentSessions.status, TERMINAL_STATUSES),
  });
  await cancelPendingTimersForRun(id).catch(() => {});
  // Event system (§6.6): close() also flips cancel_requested cross-process, so
  // mirror it with the same control-class row (deduped with cancel()'s).
  void emitInboxEvent({
    targetRunId: id,
    type: "run.cancel_requested",
    sourceKind: "system",
    sourceId: String(id),
    dedupeKey: `cancel:${id}`,
    payload: { run_id: id },
    noWake: true,
  }).catch(() => {});
  closeBus(id);
  void runDispatch.stopRunner(run.workerScope).catch(() => {});
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, await repoRoot(run)).catch(() => {});
  }
  // FIX 1 (M4): cascade to in-flight descendants, as cancel() does. Children of a
  // closed parent are CANCELLED, not closed — they are disposable workers for the
  // parent, not conversations to preserve. The target is already terminal here, so
  // the nested cancels converge (they early-return on terminal status).
  for (const child of await collectActiveDescendants(id)) {
    if (child.id === id) continue; // self-reference guard (belt for the visited-set)
    await cancel(child.id).catch(() => {});
  }
  return (await get(id))!;
}

/**
 * BUG 4: one-agent-per-task, also enforced on RESUME/dispatch. create() rejects a
 * SECOND non-terminal worktree run per task under the per-task advisory lock — but
 * that check only runs at creation. A worktree run that has gone terminal
 * (completed/failed) is RESUMABLE: a follow-up message (sendMessageToRun) or a
 * webhook autofix (followUp) can re-drive it. If a DIFFERENT run on the same task
 * became live in the meantime (created after this one finished), reviving this run
 * would put two agents on the same canonical branch.
 *
 * Returns the id of a rival live run on the SAME task — a DIFFERENT (id !=) run
 * that is non-terminal AND actually live (a fresh lease or a live worker claim) —
 * or null when there is none. Chat runs and task-less/non-worktree runs have no
 * canonical branch to contend for, so they never have a rival (returns null); this
 * also means resuming THIS run is never blocked by its own in-flight turn.
 */
async function findRivalTaskRun(run: {
  id: number;
  goal: string;
  taskId: string | null;
  cwdStrategy: string;
}): Promise<number | null> {
  if (run.goal === "<chat>" || !run.taskId || run.cwdStrategy !== "worktree") return null;
  const siblings = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.taskId, run.taskId),
        eq(agentSessions.cwdStrategy, "worktree"),
        sql`${agentSessions.goal} != '<chat>'`,
        sql`${agentSessions.id} != ${run.id}`,
        notInArray(agentSessions.status, TERMINAL_STATUS_LIST)
      )
  );
  for (const s of siblings) {
    const v = (await resolveLiveness(s.id)).verdict;
    if (v === "alive" || v === "unknown") return s.id; // unknown is not permission to spawn a rival
  }
  return null;
}

/**
 * Resume a completed/idle worktree run for an unattended follow-up turn —
 * e.g. the GitHub webhook handler reacting to a CI failure on the run's PR.
 *
 * DISPATCHES, does not execute: on a remote-runner deployment the prompt is
 * persisted and the run handed to dispatchRun (a worker Machine/container runs
 * the turn, pushes the branch, and lands the terminal status). The control
 * plane must never run the turn itself — it has no SESSION_ROOT/REPO_CACHE_DIR
 * and its image ships without git, so prepareCwd's host/dev branch fails
 * instantly (runs 133/137/140/144: "not a git repository" / spawn git ENOENT,
 * with the autofix poller re-failing already-completed runs every 2 minutes).
 *
 * Host/dev mode (no remote runner) keeps the original in-process turn:
 * re-materialize the worktree on the run's branch, run one agent turn with the
 * given prompt, push the branch (to update the PR and re-trigger CI), and
 * return the run to `completed`. A fresh SDK session is started rather than
 * resuming `sdkSessionId`, because the original session files live inside the
 * (since-cleaned-up) worktree; the prompt + the checked-out code + the gh
 * tools give the agent everything it needs.
 *
 * No-ops (resolves quietly) when the run is missing, already in flight, or has
 * no worktree branch to push to.
 */
export async function followUp(
  runId: number,
  prompt: string,
  opts: { author?: string; addProfiles?: string[]; push?: boolean } = {}
): Promise<void> {
  const run = await get(runId);
  if (!run) return;
  if (isLive(runId)) return;
  // FIX 4 (M14): the in-process isLive() check above is blind to a DETACHED worker
  // driving this same run in ANOTHER process. Without a DB check, a webhook autofix
  // would kick off a SECOND concurrent turn against the same branch/worktree. Bail
  // when the row shows a live lease (a turn in flight anywhere) or a live worker
  // owns it — mirrored below on a fresh read after the lock is acquired.
  {
    const v = (await resolveLiveness(runId)).verdict;
    if (v === "alive" || v === "unknown") return;
  }
  // BUG 4: one-agent-per-task on resume. Reviving this (terminal, resumable) run
  // while a DIFFERENT live run drives the same task would put two agents on the
  // same canonical branch. Bail quietly — same contract as the same-run liveness
  // check above ("already in flight elsewhere on the task").
  if ((await findRivalTaskRun(run)) != null) return;
  if (run.cwdStrategy !== "worktree" || !run.branch || !run.worktreePath) return;

  // Remote-runner deployments (Fly Machines / Docker worker image): route the
  // turn through dispatchRun, the same front door every other remote turn uses
  // (placement, admission, the atomic worker claim — mirroring
  // sendMessageToRun's remoteRunnerEnabled() split). The prompt is persisted as
  // a USER message deliberately: the dispatched worker rebuilds its prompt from
  // the unanswered user backlog (dispatchTurnPrompt), which replays only
  // user-role rows — a system row would be silently dropped and the worker
  // would run a bare "resume" turn instead of the CI-fix instructions.
  if (runDispatch.remoteRunnerEnabled()) {
    if (opts.addProfiles?.length) {
      // The dispatched worker mounts tools from the run ROW, not from per-call
      // options — persist the merge so the gh_pr/gh_ci tools the autofix turn
      // needs actually exist in the worker (and stay for later attempts).
      await db
        .update(agentSessions)
        .set({ toolsProfile: mergeProfiles(run.toolsProfile, opts.addProfiles) })
        .where(eq(agentSessions.id, runId));
    }
    await persistMessage(runId, "user", [{ type: "text", text: prompt }]);
    // dispatchRun is idempotent against races: a claim that landed since the
    // liveness checks above makes it return "already-claimed", and that turn
    // drains the freshly persisted message.
    await runDispatch.dispatchRun(runId);
    return;
  }

  const lock = getLock(runId);
  while (lock.busy) {
    try {
      await lock.busy;
    } catch {
      // prior turn errored; take the slot anyway
    }
  }
  // Claim the slot SYNCHRONOUSLY before any await: an await between the wait
  // loop and the claim is a window where a concurrent append()/followUp()
  // (whose own claim is synchronous after its wait loop) can observe the lock
  // free and start a turn — resuming here would then overwrite its claim and
  // drive two turns against the same worktree.
  let release!: () => void;
  lock.busy = new Promise<void>((res) => (release = res));
  // Re-check liveness after acquiring the slot (another follow-up may have run
  // while we waited). Re-read the row: a detached worker may have claimed/started
  // a turn cross-process while we were queued, which only a FRESH read reveals.
  let fresh: RunRow | null = null;
  try {
    if (!isLive(runId)) fresh = await get(runId);
  } catch (err) {
    release();
    lock.busy = null;
    throw err;
  }
  const freshVerdict = fresh ? (await resolveLiveness(runId)).verdict : "unowned";
  if (!fresh || freshVerdict === "alive" || freshVerdict === "unknown") {
    release();
    lock.busy = null;
    return;
  }

  const abort = new AbortController();
  const bus = new EventEmitter();
  registerRunner(runId, { abort, bus });
  // Keep the liveness lease fresh so this webhook-driven follow-up turn isn't
  // treated as an orphan by append()/reconcileOrphanedRuns() mid-turn.
  const heartbeat = startCancelPoll(runId);

  try {
    await persistMessage(runId, "system", [{ type: "text", text: prompt }]);
    await setStatus(runId, "running");

    const cwd = await prepareCwd(run);
    const effectiveProfile = opts.addProfiles?.length
      ? mergeProfiles(run.toolsProfile, opts.addProfiles)
      : run.toolsProfile;
    const turnRun: RunRow = { ...run, toolsProfile: effectiveProfile, sdkSessionId: null };
    const author = opts.author ?? "github-webhook";

    const result = await runOneTurn({
      run: turnRun,
      cwd,
      prompt,
      abort,
      author,
      onSdk: (m) => bus.emit("event", { type: "sdk", sdk: m }),
    });

    if (abort.signal.aborted) return;

    if (opts.push !== false) {
      try {
        await sh(["git", "push", "origin", run.branch], cwd);
      } catch (err) {
        await persistMessage(runId, "system", [
          { type: "text", text: `Follow-up: git push failed: ${describe(err)}` },
        ]);
      }
    }

    // Atomic completion (status + event) with the terminal no-op guard, so a
    // lost column write can't strand this follow-up as an orphan. Server-side
    // (webhook), so no worker retry.
    await applyStatusTx(runId, "completed", {
      set: {
        completedAt: new Date(),
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      },
      guard: notInArray(agentSessions.status, TERMINAL_STATUSES),
    });
  } catch (err) {
    if (!abort.signal.aborted) await setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
    cleanupWorktree(run.worktreePath, await repoRoot(run)).catch(() => {});
    release();
    lock.busy = null;
  }
}

// ──────────────────────────────────────────────────────────
// Worktree management & cwd resolution
// ──────────────────────────────────────────────────────────

/**
 * Resolve the repo a run belongs to: explicit repoId > task's repo > default
 * repo. Shared by repoRoot/repoDefaultBranch, which differ only in which
 * field of the resolved repo they read. The chain runs on the transport
 * (server-side in HTTP worker mode).
 */
async function resolveRepo(run: {
  id: number;
  repoId: string | null;
  taskId: string | null;
}): Promise<RepositoryRow | null> {
  return (await runTransport()).resolveRepo(run.id);
}

async function repoRoot(run: {
  id: number;
  repoId: string | null;
  taskId: string | null;
}): Promise<string> {
  const r = await resolveRepo(run);
  return r?.localPath ? resolve(r.localPath) : ORCHESTRATOR_ROOT;
}

// Guard the resolved working directory before it reaches the agent backend.
// Shared with the ws worker driver — see lib/run-cwd.ts for the rationale.
import { validateCwd } from "./run-cwd";
export { validateCwd };

async function prepareCwd(run: RunRow): Promise<string> {
  const sessionWork = sessionRepoPath();
  if (run.cwdStrategy === "none" || run.cwdStrategy === "repo") {
    // Container/Fly model: the host repoRoot()/local_path doesn't exist inside a
    // worker. Clone the repo's default branch into a runner-local dir. On Fly the
    // dir lives on the persistent session volume; on Docker it is /work/<id>.
    if (sessionWork || process.env.REPO_CACHE_DIR) {
      const work = sessionWork ?? `/work/${run.id}`;
      if (!existsSync(join(work, ".git"))) {
        const def = await repoDefaultBranch(run);
        await containerCheckoutAt(run, work, def, def);
      }
      return validateCwd(work, { runId: run.id, repoId: run.repoId });
    }
    return validateCwd(await repoRoot(run), { runId: run.id, repoId: run.repoId });
  }
  // worktree / worktree_at_pr: re-materialize if missing.
  if (!run.branch || !run.worktreePath) {
    throw new Error(
      `Run #${run.id} has cwd_strategy=${run.cwdStrategy} but no branch/worktree_path recorded yet.`
    );
  }
  // Fly resume: the checkout usually already exists on the session volume. Make
  // it current idempotently and persist the volume path so SDK cwd is stable
  // across same-machine and new-machine resumes.
  if (sessionWork) {
    if (!existsSync(join(sessionWork, ".git"))) {
      await containerCheckoutAt(run, sessionWork, run.branch);
    }
    if (run.worktreePath !== sessionWork) {
      await (await runTransport()).patchRun(run.id, { worktreePath: sessionWork });
    }
    return validateCwd(sessionWork, { runId: run.id, repoId: run.repoId });
  }
  // Worker-container resume: the prior container (and its /work checkout) is
  // gone, so re-clone from the cache and check out the already-pushed branch.
  if (process.env.REPO_CACHE_DIR) {
    if (!existsSync(run.worktreePath)) {
      const work = await containerCheckout(run, run.branch);
      return validateCwd(work, { runId: run.id, repoId: run.repoId });
    }
    return validateCwd(run.worktreePath, { runId: run.id, repoId: run.repoId });
  }
  const root = await repoRoot(run);
  if (!existsSync(run.worktreePath)) {
    await mkdir(dirname(run.worktreePath), { recursive: true });
    // The branch already exists on the remote (it was pushed by the initial
    // implement turn for implement runs, or fetched from the PR head for
    // review runs), so a plain `git worktree add <path> <branch>` is
    // sufficient — git checks out the existing branch into the new path.
    await timeRunnerPhase(
      "git_worktree_add",
      () => sh(["git", "worktree", "add", run.worktreePath!, run.branch!], root),
      { provider: runnerProviderLabel(), fields: { runId: run.id, branch: run.branch } }
    );
    await timeRunnerPhase(
      "worktree_artifact_link",
      () => linkSharedWorktreeArtifacts(run.worktreePath!, root),
      { provider: runnerProviderLabel(), fields: { runId: run.id } }
    );
  }
  return validateCwd(run.worktreePath, { runId: run.id, repoId: run.repoId });
}

// ──────────────────────────────────────────────────────────
// Unified turn engine helpers (used by append for worktree runs)
// ──────────────────────────────────────────────────────────

/**
 * Resume predicate: a worktree run (the task's attached session) can be resumed
 * even after it lands `completed`/`failed`/`budget_exhausted` — its branch and
 * worktree persist (and re-materialize on demand). `closed` and in-flight states
 * are not resumable. Non-worktree runs use the legacy idle-only rule.
 */
export function isResumableWorktreeRun(status: string, cwdStrategy: string): boolean {
  if (cwdStrategy !== "worktree") return false;
  return RESUMABLE_STATUSES.has(status);
}

/** The statuses a resumable run can be re-driven from: idle plus the soft
 *  terminals. `cancelled`/`closed` are hard stops everywhere. */
const RESUMABLE_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "completed",
  "failed",
  "budget_exhausted",
]);

/**
 * Full resume predicate for a run ROW (isResumableWorktreeRun plus the
 * executor case). A plan-executor run (<execute> with a planId) is resumable
 * after a terminal landing even though it has no worktree: its durable state
 * is Postgres — plan, tasks, notes, child runs (docs/agent-events.md §8) — and
 * its persona re-scans task state on every wake, so a follow-up message can
 * always re-drive it. Before this predicate, the append() gate admitted only
 * worktree runs, so a completed/failed executor could be resumed through the
 * dispatch path (remote deployments) but not the in-process path (dev) — the
 * same composer action erred with "cannot resume" depending on deployment.
 */
export function isResumableRun(run: {
  status: string;
  cwdStrategy: string;
  goal: string;
  planId: string | null;
}): boolean {
  if (isResumableWorktreeRun(run.status, run.cwdStrategy)) return true;
  return run.goal === "<execute>" && !!run.planId && RESUMABLE_STATUSES.has(run.status);
}

/**
 * Distinguishes the two flavors of worktree run. Implement-style runs follow the
 * branch → push → PR lifecycle and land `completed`. Chat-goal worktree runs
 * (e.g. a Discord conversation) get a private worktree purely for filesystem
 * isolation: no auto-push, no PR, and they stay `idle`/resumable like any chat.
 */
export function isImplementWorktree(run: { cwdStrategy: string; goal: string }): boolean {
  return run.cwdStrategy === "worktree" && run.goal !== "<chat>";
}

/**
 * The task's canonical branch name: `claude/<taskid>`. Deterministic, so every
 * run on the task computes the same name even before the reservation on
 * tasks.branch has landed. All agent work on a task accumulates here — one
 * branch, one PR, across every run.
 */
export function taskBranchName(taskId: string): string {
  return `claude/${taskId.toLowerCase()}`;
}

/**
 * Branch name for a worktree run. Task-attached (implement) runs share the
 * task's canonical branch (`claude/<taskid>`); only taskless chat worktrees
 * get a private per-run branch (`claude/chat-<run>`).
 */
export function worktreeBranchName(run: { id: number; taskId: string | null }): string {
  if (run.taskId) return taskBranchName(run.taskId);
  return `claude/chat-${run.id}`;
}

/**
 * Reserve the task's canonical branch inside create()'s admission transaction.
 * First reservation wins and sticks: prefer an already-set tasks.branch, then
 * adopt the attached run's branch (legacy `claude/<task>-<run>` continuity, so
 * pre-migration tasks keep their pushed branch + open PR), else mint
 * `claude/<taskid>`.
 */
async function reserveTaskBranch(
  tx: Pick<typeof db, "select" | "update">,
  taskId: string
): Promise<string | null> {
  const row = (
    await tx
      .select({ branch: tasks.branch, attachedRunId: tasks.attachedRunId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
  )[0];
  if (!row) return null; // missing task → the insert's FK surfaces the real error
  if (row.branch) return row.branch;
  let branch: string | null = null;
  if (row.attachedRunId != null) {
    const attached = (
      await tx
        .select({ branch: agentSessions.branch })
        .from(agentSessions)
        .where(eq(agentSessions.id, row.attachedRunId))
    )[0];
    branch = attached?.branch ?? null;
  }
  branch ??= taskBranchName(taskId);
  await tx.update(tasks).set({ branch }).where(eq(tasks.id, taskId));
  return branch;
}

/** The base branch a task's worktree branches from / merges in. */
async function repoDefaultBranch(run: {
  id: number;
  repoId: string | null;
  taskId: string | null;
}): Promise<string> {
  return (await resolveRepo(run))?.defaultBranch ?? "main";
}

/**
 * First turn of a worktree run: create its branch (`claude/<task>-<run>`) and
 * worktree off the base branch, persist them, and move the task to in_progress.
 * No-op once a branch exists (later turns re-materialize via prepareCwd).
 */
function sessionRepoPath(): string | null {
  // A managed runner with a pre-populated filesystem supplies its checkout
  // directly. It must be an absolute path: accepting a relative value would
  // make a worker's repo depend on its launch cwd and risks operating in the
  // worker-runtime checkout instead of the selected repo.
  const configured = config.worker.runnerRepoPath;
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("TASK_ORCH_RUNNER_REPO_PATH must be an absolute path inside the runner.");
    }
    return resolve(configured);
  }
  const root = process.env.SESSION_ROOT;
  return root ? resolve(root, "repo") : null;
}

function isConfiguredRunnerRepoPath(work: string): boolean {
  const configured = config.worker.runnerRepoPath;
  return !!configured && path.isAbsolute(configured) && resolve(configured) === resolve(work);
}

// Shallow-clone flags for the in-runner checkout, from TASK_ORCH_GIT_CLONE_DEPTH
// (default 1). Depth caps the commit/tree history each cold clone transfers; the
// paired `--no-single-branch` still fetches every branch tip so the later
// origin/<base> fallback checkout can resolve. A depth of 0 disables shallowing
// and restores a full-history clone. Compatible with `--filter=blob:none` and
// with the `--reference` mirror below (both narrow what a cold clone moves).
export function gitCloneDepthArgs(): string[] {
  const depth = config.deployment.gitCloneDepth;
  return depth > 0 ? ["--depth", String(depth), "--no-single-branch"] : [];
}

// Worker/Fly git checkout: clone the run's repo from GitHub, optionally using the
// mounted repo-cache mirror as an object reference. With `base` set, branch off
// origin/base (first turn); without it, check out the existing pushed branch
// (resume), falling back to the repo default for chat branches that never pushed.
// Idempotent: if `work` already contains a clone, fetch + checkout in place.
async function containerCheckoutAt(
  run: RunRow,
  work: string,
  branch: string,
  base?: string
): Promise<string> {
  const repoRow = await resolveRepo(run);
  const parsed = ownerRepoFromRemote(repoRow?.remote ?? null);
  if (!parsed) {
    throw new Error(
      `Run #${run.id}: repository '${run.repoId ?? "(default)"}' has no GitHub remote to clone for the worker.`
    );
  }
  if (!process.env.GH_TOKEN) {
    throw new Error(`Run #${run.id}: GH_TOKEN is required for in-runner checkout.`);
  }
  const cache = process.env.REPO_CACHE_DIR;
  const mirror = cache ? resolve(cache, `${parsed.owner}_${parsed.repo}.git`) : "";
  const url = `https://github.com/${parsed.owner}/${parsed.repo}`;
  await mkdir(dirname(work), { recursive: true });
  if (!(await hasUsableGitCheckout(work))) {
    // A configured runner repo path promises an already-selected checkout.
    // Never delete and reclone it: a bad path should fail loudly, while a
    // resumed runner may contain the only copy of uncommitted run work.
    if (isConfiguredRunnerRepoPath(work)) {
      throw new Error(
        `Run #${run.id}: configured runner repository '${work}' is missing or is not a valid Git checkout. ` +
          "Repair TASK_ORCH_RUNNER_REPO_PATH."
      );
    }
    if (existsSync(work)) await rm(work, { recursive: true, force: true });
    const reference = mirror && existsSync(mirror) ? ["--reference", mirror, "--dissociate"] : [];
    // Blobless partial clone: history blobs are fetched on demand through the
    // image's git credential helper; pairs with the image-baked blobless mirror
    // so a cold clone moves only refs/commits/trees plus the checkout's blobs.
    // gitCloneDepthArgs additionally caps the commit/tree history transferred.
    const depth = gitCloneDepthArgs();
    await timeRunnerPhase(
      "git_clone",
      () => sh(["git", "clone", "--filter=blob:none", ...depth, ...reference, url, work], "/"),
      {
        provider: runnerProviderLabel(),
        fields: {
          runId: run.id,
          repoId: run.repoId,
          reference: reference.length > 0,
          shallow: depth.length > 0,
        },
      }
    );
  } else {
    await sh(["git", "-C", work, "remote", "set-url", "origin", url], "/").catch(() => {});
  }
  await timeRunnerPhase(
    "git_fetch",
    () => sh(["git", "-C", work, "fetch", "--prune", "origin"], "/").catch(() => {}),
    { provider: runnerProviderLabel(), fields: { runId: run.id, repoId: run.repoId } }
  );
  // Ensure semantics, existing-branch first: a task's branch is shared by every
  // run on the task, so a previous run may already have pushed it. Prefer the
  // branch's own remote state (`checkout -B <branch> origin/<branch>` — which
  // also sets upstream tracking); only branch off `base` (or the repo default)
  // when origin/<branch> doesn't exist yet. Resetting onto origin/<base> when
  // the branch already exists would silently discard the earlier runs' commits.
  try {
    await timeRunnerPhase(
      "git_fetch_branch",
      () => sh(["git", "-C", work, "fetch", "origin", branch], "/"),
      { provider: runnerProviderLabel(), fields: { runId: run.id, branch } }
    );
    await timeRunnerPhase(
      "git_checkout",
      () => sh(["git", "-C", work, "checkout", "-B", branch, `origin/${branch}`], "/"),
      { provider: runnerProviderLabel(), fields: { runId: run.id, branch } }
    );
  } catch {
    const fallback = base ?? (await repoDefaultBranch(run));
    await timeRunnerPhase(
      "git_checkout",
      () => sh(["git", "-C", work, "checkout", "-B", branch, `origin/${fallback}`], "/"),
      { provider: runnerProviderLabel(), fields: { runId: run.id, branch, base: fallback, fallback: true } }
    );
  }
  // Link the image-baked node_modules tree (full `npm ci` + Playwright) into this
  // checkout when it is the prewarmed repo, so the agent starts with deps ready
  // instead of paying a cold install. No-op off Fly / for other repos. Best-effort.
  await timeRunnerPhase(
    "prewarm_apply",
    () => applyPrewarmToCheckout(work),
    { provider: runnerProviderLabel(), fields: { runId: run.id, repoId: run.repoId } }
  );
  return work;
}

async function containerCheckout(
  run: RunRow,
  branch: string,
  base?: string
): Promise<string> {
  const work = `/work/${run.id}`;
  await mkdir("/work", { recursive: true });
  return containerCheckoutAt(run, work, branch, base);
}

async function hasUsableGitCheckout(work: string): Promise<boolean> {
  if (!existsSync(join(work, ".git"))) return false;
  try {
    const out = await sh(["git", "-C", work, "rev-parse", "--is-inside-work-tree"], "/");
    return out.trim() === "true";
  } catch {
    return false;
  }
}

// Review-run container checkout: clone the repo from the repo-cache mirror into
// /work/<id>, fetch the PR head into a stable per-run ref, and check it out on a
// throwaway review branch. Auth for the clone/fetch comes from the worker image's
// git credential helper (GH_TOKEN). Returns the container-local worktree path.
async function containerReviewCheckoutAt(
  run: RunRow,
  work: string,
  prNumber: number,
  branch: string,
  reviewRef: string
): Promise<string> {
  const repoRow = await resolveRepo(run);
  const parsed = ownerRepoFromRemote(repoRow?.remote ?? null);
  if (!parsed) {
    throw new Error(
      `repository '${run.repoId ?? "(default)"}' has no GitHub remote to clone for the review container.`
    );
  }
  if (!process.env.GH_TOKEN) {
    throw new Error("GH_TOKEN is required for in-container review checkout.");
  }
  const cache = process.env.REPO_CACHE_DIR;
  const mirror = cache ? resolve(cache, `${parsed.owner}_${parsed.repo}.git`) : "";
  const url = `https://github.com/${parsed.owner}/${parsed.repo}`;
  await mkdir(dirname(work), { recursive: true });
  if (!(await hasUsableGitCheckout(work))) {
    if (existsSync(work)) await rm(work, { recursive: true, force: true });
    const reference = mirror && existsSync(mirror) ? ["--reference", mirror, "--dissociate"] : [];
    // Blobless partial clone (see containerCheckoutAt): blobs fetched on demand.
    await sh(["git", "clone", "--filter=blob:none", ...reference, url, work], "/");
  } else {
    await sh(["git", "-C", work, "remote", "set-url", "origin", url], "/").catch(() => {});
  }
  await sh(["git", "-C", work, "fetch", "origin", `pull/${prNumber}/head:${reviewRef}`], "/");
  await sh(["git", "-C", work, "checkout", "-B", branch, reviewRef], "/");
  return work;
}

async function containerReviewCheckout(
  run: RunRow,
  prNumber: number,
  branch: string,
  reviewRef: string
): Promise<string> {
  const work = `/work/${run.id}`;
  await mkdir("/work", { recursive: true });
  return containerReviewCheckoutAt(run, work, prNumber, branch, reviewRef);
}

async function ensureWorktreeBranch(run: RunRow, baseBranch?: string): Promise<RunRow> {
  if (run.cwdStrategy !== "worktree" || run.branch) return run;
  const transport = await runTransport();
  const task = run.taskId ? await transport.getTask(run.taskId) : null;
  // The task's canonical branch, reserved on tasks.branch at create() time so
  // every run on the task works the SAME branch (legacy tasks may carry an
  // adopted `claude/<task>-<run>` name there). The deterministic fallback
  // covers runs created before the reservation existed; taskless chat
  // worktrees keep a private per-run branch.
  const branch = task?.branch ?? worktreeBranchName(run);
  const base = baseBranch?.trim() || (await repoDefaultBranch(run));
  let worktreePath: string;
  const sessionWork = sessionRepoPath();
  if (sessionWork) {
    // Fly mode: clone/checkout on the persistent per-run volume. The same path is
    // reused across same-machine resumes and new machines attached to the volume.
    worktreePath = await containerCheckoutAt(run, sessionWork, branch, base);
  } else if (process.env.REPO_CACHE_DIR) {
    // Worker-container mode: clone from the mounted repo-cache mirror into a
    // container-local dir and branch off `base` there, instead of a host-shared
    // git worktree. The checkout is ephemeral (the container is --rm); durable
    // state lives on GitHub (the branch is pushed) + Postgres.
    worktreePath = await containerCheckout(run, branch, base);
  } else {
    worktreePath = await localWorktreeFor(run, branch, base);
  }
  // Publish the branch with upstream tracking the moment it exists, so the
  // task page can link it on GitHub and a plain `git push` from the agent (or
  // the salvage sync) targets the right ref without remembering `-u origin`.
  // Best-effort: offline/credential failures must not block the first turn.
  await publishBranch(worktreePath, branch);
  await transport.patchRun(run.id, {
    branch,
    worktreePath,
    repoId: run.repoId ?? task?.repoId ?? null,
  });
  // Task-attached (implement) runs move their task to in_progress; taskless chat
  // worktrees have nothing to transition.
  if (run.taskId && task && (task.state === "todo" || task.state === "blocked")) {
    try {
      await transport.transitionTask(run.taskId, {
        state: "in_progress",
        assignee: task.assignee ?? "claude-agent",
        note: `Started agent run #${run.id}.`,
      });
    } catch {
      // Best-effort.
    }
  }
  return (await get(run.id))!;
}

/**
 * Local (host git-worktree) checkout for a worktree run. Task runs share ONE
 * checkout per task (`.worktrees/<taskid>`): git only allows a branch to be
 * checked out in one worktree, and the leftover files there are exactly the
 * state the next run on the task should continue from. Handles every branch
 * state: already checked out somewhere (reuse), exists locally (attach),
 * exists on origin only (attach with tracking), or brand new (branch off base).
 */
async function localWorktreeFor(run: RunRow, branch: string, base: string): Promise<string> {
  const root = await repoRoot(run);
  // Already checked out (a previous run on this task, or a legacy per-run
  // worktree that owns the adopted branch) → reuse that checkout.
  const existing = await worktreePathForBranch(root, branch);
  if (existing && existsSync(existing)) return existing;
  const worktreeRoot = resolve(root, ".worktrees");
  const worktreePath = resolve(
    worktreeRoot,
    run.taskId ? run.taskId.toLowerCase() : String(run.id)
  );
  await mkdir(worktreeRoot, { recursive: true });
  // See the branch's remote state before deciding how to attach; a previous
  // run may have pushed it even though no local ref survives.
  await sh(["git", "fetch", "origin", branch], root).catch(() => {});
  const hasRef = (ref: string) =>
    sh(["git", "rev-parse", "--verify", "--quiet", ref], root).then(
      () => true,
      () => false
    );
  const args = (await hasRef(`refs/heads/${branch}`))
    ? ["git", "worktree", "add", worktreePath, branch]
    : (await hasRef(`refs/remotes/origin/${branch}`))
      ? ["git", "worktree", "add", "-b", branch, worktreePath, `origin/${branch}`]
      : ["git", "worktree", "add", "-b", branch, worktreePath, base];
  await timeRunnerPhase("git_worktree_add", () => sh(args, root), {
    provider: runnerProviderLabel(),
    fields: { runId: run.id, branch, base },
  });
  await timeRunnerPhase(
    "worktree_artifact_link",
    () => linkSharedWorktreeArtifacts(worktreePath, root),
    { provider: runnerProviderLabel(), fields: { runId: run.id } }
  );
  return worktreePath;
}

/** Where (if anywhere) `branch` is currently checked out, via
 *  `git worktree list --porcelain`. Null when no worktree holds it. */
async function worktreePathForBranch(root: string, branch: string): Promise<string | null> {
  try {
    const out = await sh(["git", "worktree", "list", "--porcelain"], root);
    let current: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
      else if (line === `branch refs/heads/${branch}`) return current;
    }
  } catch {
    // git too old for --porcelain / not a repo — fall through to a fresh add.
  }
  return null;
}

/**
 * Publish `branch` to origin with upstream tracking (`git push -u`). When the
 * push can't happen (offline, missing credentials), still record the tracking
 * config so a later plain `git push` targets origin/<branch>. Best-effort by
 * design — branch publication must never fail a turn.
 */
async function publishBranch(cwd: string, branch: string): Promise<void> {
  try {
    await timeRunnerPhase(
      "git_publish_branch",
      () => sh(["git", "push", "-u", "origin", branch], cwd),
      { provider: runnerProviderLabel(), fields: { branch } }
    );
  } catch {
    await sh(["git", "config", `branch.${branch}.remote`, "origin"], cwd).catch(() => {});
    await sh(
      ["git", "config", `branch.${branch}.merge`, `refs/heads/${branch}`],
      cwd
    ).catch(() => {});
  }
}

/**
 * Commit everything left in the working tree (`git add -A`), if anything is.
 * The salvage half of "the worker can finish the PR from whatever is on the
 * branch": an agent that stopped without committing still gets its work
 * carried into the push + PR. Returns whether a commit was made.
 */
export async function commitLeftoverChanges(cwd: string, message: string): Promise<boolean> {
  const dirty = (await sh(["git", "status", "--porcelain"], cwd)).trim();
  if (!dirty) return false;
  await sh(["git", "add", "-A"], cwd);
  await sh(["git", "commit", "-m", message], cwd);
  return true;
}

/**
 * After a worktree turn: if the branch gained commits ahead of its base, push
 * them. The first time (no PR yet) open one and move the task to review;
 * afterwards the push just updates the existing PR. Returns the (possibly new)
 * PR url. A no-op when the turn produced no commits (pure conversation).
 *
 * With `commitLeftovers` (the salvage pass), uncommitted files are committed
 * first so work an agent left in the tree still reaches the branch and PR.
 */
async function gitSyncAfterTurn(
  run: RunRow,
  cwd: string,
  summary: string | null,
  baseBranch?: string,
  opts?: { commitLeftovers?: boolean }
): Promise<string | null> {
  if (!run.branch) return run.prUrl;
  if (opts?.commitLeftovers) {
    try {
      const committed = await commitLeftoverChanges(
        cwd,
        `chore${run.taskId ? `(${run.taskId})` : ""}: commit remaining agent work from run #${run.id}`
      );
      if (committed) {
        await persistMessage(run.id, "system", [
          { type: "text", text: "Committed uncommitted changes left in the worktree." },
        ]);
      }
    } catch (err) {
      await persistMessage(run.id, "system", [
        { type: "text", text: `Could not commit leftover changes: ${describe(err)}` },
      ]);
    }
  }
  const base = baseBranch?.trim() || (await repoDefaultBranch(run));
  // Count the commits this branch added beyond its base. Prefer the
  // remote-tracking base (origin/<base>): it reflects the branch's real PR base
  // and isn't thrown off by a stale local checkout of <base>. Fall back to the
  // local ref when origin/<base> hasn't been fetched.
  let baseRef = base;
  try {
    await sh(["git", "rev-parse", "--verify", "--quiet", `origin/${base}`], cwd);
    baseRef = `origin/${base}`;
  } catch {
    // origin/<base> unavailable; use the local base ref.
  }
  let ahead = 0;
  try {
    const out = await sh(["git", "rev-list", "--count", `${baseRef}..HEAD`], cwd);
    ahead = parseInt(out.trim() || "0", 10) || 0;
  } catch {
    ahead = 0;
  }
  if (ahead <= 0) return run.prUrl;

  await sh(["git", "push", "-u", "origin", run.branch], cwd);
  if (run.prUrl) return run.prUrl;
  if (!run.taskId) return null;
  const transport = await runTransport();
  const task = await transport.getTask(run.taskId);
  if (!task) return null;
  if (task.prUrl) return task.prUrl;
  const prUrl = await openPr({ task, branch: run.branch, baseBranch: base, worktreePath: cwd, summary });
  if (prUrl) {
    const setPr = await transport.callTool(
      run.id,
      "set_task_pr",
      { task_id: run.taskId, pr_url: prUrl },
      { author: "claude-agent" }
    );
    if (setPr.isError) {
      const text = setPr.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
      await transport.addTaskNote(
        run.taskId,
        "claude-agent",
        `Could not record task PR: ${text || "set_task_pr failed"}`
      );
      try {
        await transport.transitionTask(run.taskId, {
          state: "testing",
          note: `Agent finished. PR: ${prUrl}`,
        });
      } catch (err) {
        await transport.addTaskNote(run.taskId, "claude-agent", `Could not transition to testing: ${describe(err)}`);
      }
    }
    const armed = await armAutoMerge(prUrl, cwd);
    await transport.addTaskNote(
      run.taskId,
      "claude-agent",
      armed
        ? `Fallback PR sync armed auto-merge for ${prUrl}.`
        : `Opened PR ${prUrl}, but could not arm GitHub auto-merge automatically.`
    );
  }
  return prUrl ?? run.prUrl;
}

/** Fire a worktree run's first turn through the unified engine, server-side. */
async function kickoffFirstTurn(
  runId: number,
  prompt: string,
  baseBranch?: string,
  takeover?: boolean,
  persistUser?: boolean
): Promise<void> {
  try {
    for await (const ev of append({ runId, role: "user", text: prompt, baseBranch, takeover, persistUser })) {
      void ev; // drained; live events reach the run-view via the /events bus
    }
  } catch {
    // append marks the run failed on error; nothing else to do here.
  }
}

// ──────────────────────────────────────────────────────────
// Review-style worker (worktree at PR head → single turn → outcome)
// ──────────────────────────────────────────────────────────

async function runReview(
  runId: number,
  prUrl: string,
  initialPrompt: string | null
): Promise<void> {
  const abort = new AbortController();
  const bus = new EventEmitter();
  registerRunner(runId, { abort, bus });
  // Keep the liveness lease fresh for the whole worker (prepare → turn), so an
  // append()/reconcileOrphanedRuns() can't mistake this live review for an
  // orphan and take it over / mark it failed mid-turn. The same interval polls
  // the cross-process cancel flag so a detached review aborts on cancel().
  // Started INSIDE the try below (matches append()): starting it here, with
  // awaited calls before the try, would leak the interval forever if one of
  // those awaits threw before the finally could clear it.
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  let run!: RunRow;
  const branch = `review-${runId}`;
  // Stable, per-run ref for the fetched PR head. FETCH_HEAD is a single shared
  // file in the repo's .git, so under concurrent runs another run's `git fetch`
  // (or a prune/gc) can clobber it between our fetch and the worktree add — the
  // observed `fatal: invalid reference: FETCH_HEAD` failure. A named ref is
  // unique per run and immune to that race.
  const reviewRef = `refs/reviews/${runId}`;
  // Resolved during prep (container clone vs host worktree). Declared here for the
  // finally's best-effort cleanup.
  let root = "";
  let worktreePath = "";

  try {
    heartbeat = startCancelPoll(runId, abort);
    run = (await get(runId))!;
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      await setError(runId, `Could not parse PR url: ${prUrl}`);
      runners.delete(runId);
      return;
    }

    await setStatus(runId, "preparing");

    const sessionWork = sessionRepoPath();
    if (sessionWork || process.env.REPO_CACHE_DIR) {
      // Worker/Fly container: clone the repo into the runner-local checkout
      // (/mnt/session/repo on Fly, /work/<id> for Docker), fetch the PR head,
      // and check it out there. Host localPath/.worktrees do not exist inside
      // remote runners.
      try {
        worktreePath = sessionWork
          ? await containerReviewCheckoutAt(run, sessionWork, parsed.number, branch, reviewRef)
          : await containerReviewCheckout(run, parsed.number, branch, reviewRef);
      } catch (err) {
        await setError(runId, `Could not check out PR ${prUrl} for review: ${describe(err)}`);
        runners.delete(runId);
        return;
      }
      root = worktreePath; // git commands run inside the clone
    } else {
      // Host/dev mode: worktree off the repo's local checkout. Fetch the PR head
      // into a stable per-run ref, then create a worktree on a throwaway review
      // branch pointing at that ref.
      root = await repoRoot(run);
      const worktreeRoot = resolve(root, ".worktrees");
      worktreePath = resolve(worktreeRoot, `review-${runId}`);
      await mkdir(worktreeRoot, { recursive: true });
      try {
        await sh(["git", "fetch", "origin", `pull/${parsed.number}/head:${reviewRef}`], root);
      } catch (err) {
        await setError(
          runId,
          `git fetch failed for ${prUrl}: ${describe(err)}. Is the PR's origin remote configured?`
        );
        runners.delete(runId);
        return;
      }
      await sh(["git", "worktree", "add", "-b", branch, worktreePath, reviewRef], root);
      await linkSharedWorktreeArtifacts(worktreePath, root);
    }

    await (await runTransport()).patchRun(runId, { branch, worktreePath });
    run = (await get(runId))!;

    await setStatus(runId, "running");
    const prompt =
      initialPrompt ??
      `Review the PR at ${prUrl} against the task's acceptance criteria. End with a JSON verdict block.`;
    const author = "claude-reviewer";
    const result = await runOneTurn({
      run,
      cwd: worktreePath,
      prompt,
      abort,
      author,
      onSdk: (m) => bus.emit("event", { type: "sdk", sdk: m }),
    });

    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }

    // Extract structured verdict from the final assistant text for the
    // outcome column. Falls back to the first non-empty line if no JSON
    // verdict block was emitted.
    const outcome = extractReviewOutcome(result.summary);

    // Atomic completion (status + event), worker path → retry the guarded
    // finalize on a transient blip before this single-turn worker exits.
    const transport = await runTransport();
    await transport.applyStatus(runId, "completed", {
      set: {
        completedAt: new Date(),
        outcome,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      },
      guard: "not-terminal",
      retries: FINALIZE_RETRIES,
    });

    // An approving verdict marks the task merged (the sole success terminal).
    // The outcome is the JSON verdict block extracted above (or a fallback
    // first line, which won't parse — so a non-approve outcome simply leaves
    // the task untouched).
    if (run.taskId && parseReviewVerdict(outcome) === "approve") {
      try {
        await transport.transitionTask(run.taskId, {
          state: "merged",
          note: `Review run #${runId} approved the PR.`,
        });
      } catch (err) {
        await transport.addTaskNote(
          run.taskId,
          "claude-reviewer",
          `Review approved but could not transition task to merged: ${describe(err)}`
        );
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    await setError(runId, describe(err), { retries: FINALIZE_RETRIES });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
    // Last resort: never let a review turn end without SOME terminal status — the
    // executor's await_session polls this run's status and would otherwise hang
    // until the orphan reaper's timeout. An aborted turn is exempt: whoever
    // aborted (cancel/interrupt) already decided the run's state.
    if (!abort.signal.aborted) {
      try {
        const cur = await get(runId);
        // 'parked' is a deliberate landing (§6.1), not a missing result.
        if (cur && !isTerminalStatus(cur.status) && cur.status !== "parked") {
          await setError(runId, "Review turn ended without a result (worker interrupted).");
        }
      } catch {
        // best-effort
      }
    }
    cleanupWorktree(worktreePath, root)
      // Drop the per-run fetch ref once the worktree is gone so refs/reviews/*
      // doesn't accumulate. Best-effort: a missing ref is fine.
      .then(() => sh(["git", "update-ref", "-d", reviewRef], root).catch(() => {}))
      .catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Plan-executor worker (one long-running agent drives the whole plan)
// ──────────────────────────────────────────────────────────

async function runExecute(
  runId: number,
  planId: string,
  initialPrompt: string | null
): Promise<void> {
  const abort = new AbortController();
  const bus = new EventEmitter();
  registerRunner(runId, { abort, bus });
  // Keep the liveness lease fresh for the whole (long-running) executor turn so
  // append()/reconcileOrphanedRuns() never treat this live run as an orphan. The
  // same interval polls the cross-process cancel flag so a detached executor
  // aborts on cancel(). Started INSIDE the try below (matches append()): starting
  // it here, with an awaited get() before the try, would leak the interval
  // forever if that await threw before the finally could clear it.
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  let run!: RunRow;

  try {
    heartbeat = startCancelPoll(runId, abort);
    run = (await get(runId))!;
    const transport = await runTransport();
    const plan = await transport.getPlan(planId);
    if (!plan) {
      await setError(runId, `Plan ${planId} disappeared before execution could start`);
      runners.delete(runId);
      return;
    }

    await setStatus(runId, "running");
    // Event system (§6.1): fresh turn = fresh intent — clear last turn's
    // park_reason and result before this turn runs (this is how a parked
    // executor woken by the pump sweep starts clean).
    await transport.patchRun(runId, { parkReason: null, result: null });
    // No worktree of its own — operate at the repo root so gh_pr tools shell
    // out against the real checkout. Children create their own worktrees.
    const cwd = await prepareCwd(run);
    // The execute scaffold (orchestration loop + task list) always runs; an
    // operator-supplied prompt is appended as steering guidance rather than
    // replacing it, so the executor never loses its core instructions.
    const base = buildExecutePrompt(plan, await transport.listTasks({ planId }));
    const extra = initialPrompt?.trim();
    let prompt = extra ? `${base}\n\n## Operator instructions\n\n${extra}` : base;
    // Digest injection (§6.4): a (re)dispatched executor consumes its pending
    // inbox events at turn start — the digest frame is persisted and the same
    // data rides the prompt. Best-effort: never block the turn on the inbox.
    try {
      const digest = await transport.claimInboxDigest(runId);
      if (digest) prompt = `${prompt}\n\n${digest}`;
    } catch {
      // pump sweep / next turn retries pending events
    }
    // Persist the kickoff prompt so a page load shows what this executor was
    // asked to do. The backend receives the prompt directly (sdk-session
    // context), so the row is display-only and carries the historical 'system'
    // role.
    await persistMessage(runId, "system", [{ type: "text", text: prompt }]);

    // The turn drives through runOneTurn (sdk-session context). The event tools
    // write parkReason/result via the transport and the finalize below lands the
    // status.
    const result = await runOneTurn({
      run,
      cwd,
      prompt,
      abort,
      author: "claude-executor",
      onSdk: (m) => bus.emit("event", { type: "sdk", sdk: m }),
    });

    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }

    // Turn-end parking contract (§6.1): the executor is THE parking consumer —
    // timer__sleep / ask_parent write park_reason mid-turn, report_result /
    // raise write result. Re-read both freshly and decide the landing status.
    const turnEnd = await readTurnEndState(runId);
    const endStatus = decideTurnEndStatus({
      goal: "<execute>",
      freshStatus: turnEnd.status,
      parkReason: turnEnd.parkReason,
      result: turnEnd.result,
      budgetHit: false,
      defaultStatus: "completed",
    });
    // Atomic landing (status + event) with the terminal no-op guard. endStatus
    // may be non-terminal (parked) — the guard only bites once the row is already
    // terminal, and the landing fires the child event only for terminal
    // landings. Worker path → retry the guarded finalize on a transient blip.
    await transport.applyStatus(runId, endStatus, {
      set: {
        parkReason: endStatus === "parked" ? turnEnd.parkReason : null,
        completedAt: isTerminalStatus(endStatus) ? new Date() : null,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      },
      guard: "not-terminal",
      retries: FINALIZE_RETRIES,
    });

    // Fallback: if the agent drove every task to a terminal state but didn't
    // close the plan itself, mark the plan done. (Skipped when the executor
    // parked — it is still mid-plan by its own account.)
    try {
      if (endStatus === "completed") {
        const tasks = await transport.listTasks({ planId });
        const allClosed =
          tasks.length > 0 &&
          tasks.every((t) => t.state === "merged" || t.state === "cancelled");
        const planNow = await transport.getPlan(planId);
        if (allClosed && planNow && planNow.state === "accepted") {
          await transport.updatePlanState(planId, "done");
        }
      }
    } catch {
      // Best-effort — the agent's own transition_plan is the primary path.
    }
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    await setError(runId, describe(err), { retries: FINALIZE_RETRIES });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
    // Last resort: an executor turn must always land a terminal status (its
    // children/UI poll it). Aborted turns are exempt — cancel/interrupt already
    // decided the run's state.
    if (!abort.signal.aborted) {
      try {
        const cur = await get(runId);
        // 'parked' is a deliberate landing (§6.1) — the executor yielded and
        // waits for inbox events; it must NOT be failed as result-less.
        if (cur && !isTerminalStatus(cur.status) && cur.status !== "parked") {
          await setError(runId, "Executor turn ended without a result (worker interrupted).");
        }
      } catch {
        // best-effort
      }
    }
  }
}

// ──────────────────────────────────────────────────────────
// Detached-worker re-entry
// ──────────────────────────────────────────────────────────

/**
 * Re-entry point for a detached worker process (scripts/run-worker.ts). Picks
 * the right worker for an already-created (and claimed) run and drives one turn
 * to completion, mirroring the in-process launch branches in create()/append().
 *
 * runReview / runExecute / kickoffFirstTurn stay module-private — a detached
 * process only ever enters through here, then exits when the turn lands a
 * terminal status. A missing run is a no-op (the row may have been reaped).
 */
// ──────────────────────────────────────────────────────────
// Server-side turn claim (R2)
// ──────────────────────────────────────────────────────────
//
// A 'server'-placement run's turns run IN-PROCESS on the web server, not in a
// worker — so they never took the atomic worker_scope claim that dispatchRun's
// worker path takes. Duplicate wakes (an inbox emit-time wake racing the pump's
// parked-wake sweep, or two inbox events landing together) could then drive two
// coordinator turns for the same run concurrently. These helpers give the
// server path the SAME single-owner claim, reusing the worker claim's columns
// (worker_scope / heartbeat_at) and CAS shape so one reaper covers both. The
// scope is prefixed 'server-' purely for forensics — nothing branches on it.

function serverTurnNonce(): string {
  return serverClaimScope(runNonce());
}

/**
 * Atomically claim a run for one in-process server turn. Same CAS as
 * dispatchRun's worker claim — succeeds only while worker_scope IS NULL and the
 * run isn't a hard-terminal cancelled/closed — but stamps a 'server-<nonce>'
 * scope and a fresh heartbeat instead of provisioning a worker. Returns the
 * scope token when claimed; `claimed: false` means another turn (server or
 * worker) already owns the run, and the caller must NOT drive a turn (the
 * running turn drains pending inbox events via its digest injection; the pump
 * sweep retries anything it missed).
 */
export async function claimServerTurn(
  runId: number,
  opts: { takeoverStale?: boolean } = {}
): Promise<{ claimed: boolean; scope: string; previousStatus: SessionStatus | null }> {
  const scope = serverTurnNonce();
  const current = await get(runId);
  // WHO MAY TAKE THE CLAIM. Default: an unowned run only (worker_scope IS NULL),
  // byte-identical to dispatchRun's worker claim — a wake that loses is a clean
  // no-op, so waiting for the owner is always correct there.
  //
  // takeoverStale (append's path only): a run whose claim-holder's heartbeat has
  // gone stale is an ORPHAN, and append has always taken those over — its
  // in-flight guard deliberately falls through on a stale lease so a crashed
  // web/pipe process can't wedge a conversation until the reaper runs. Without
  // this, adding the claim to append would REMOVE that recovery (worker_scope
  // survives a process death; nothing clears it for a server row until
  // reconcileOrphanedRuns). Same stale window as every other liveness decision.
  const [instance] = current ? await db.select({ incarnation: runnerInstances.workerIncarnation })
    .from(runnerInstances).where(eq(runnerInstances.runId, runId)) : [];
  const verdict = opts.takeoverStale && current ? await resolveLiveness(runId) : null;
  const claimable = opts.takeoverStale && current && verdict?.verdict !== "alive" && verdict?.verdict !== "unknown"
    ? (current.workerScope == null
        ? isNull(agentSessions.workerScope)
        : and(
            eq(agentSessions.workerScope, current.workerScope),
            incarnationFence(runId, instance?.incarnation ?? null)
          ))
    : isNull(agentSessions.workerScope);
  const prior = (
    await db
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(and(eq(agentSessions.id, runId), claimable))
      .limit(1)
  )[0];
  if (!prior || HARD_TERMINAL_STATUSES.includes(prior.status as SessionStatus)) {
    return { claimed: false, scope, previousStatus: null };
  }
  const claimed = await db
    .update(agentSessions)
    .set({ status: "preparing", workerScope: scope, claimedAt: new Date(), pendingSince: null })
    .where(
      and(
        eq(agentSessions.id, runId),
        claimable,
        eq(agentSessions.status, prior.status),
        notInArray(agentSessions.status, HARD_TERMINAL_STATUSES)
      )
    );
  return {
    claimed: claimed.count > 0,
    scope,
    previousStatus: claimed.count > 0 ? (prior.status as SessionStatus) : null,
  };
}

/**
 * Release a server-turn claim — clear worker_scope ONLY if this scope still owns
 * it (guarded UPDATE). Leaves whatever status the turn's landing wrote (parked /
 * completed / idle / failed) untouched: the claim is orthogonal to the run's
 * lifecycle status. Guarding on the scope makes this a no-op if a false-death
 * reaper already released and something else re-claimed — mirroring the worker
 * releaseClaim's own-the-scope discipline.
 */
export async function releaseServerTurn(runId: number, scope: string): Promise<void> {
  await db
    .update(agentSessions)
    .set({ workerScope: null })
    .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, scope)));
}

/**
 * Undo claimServerTurn's `status='preparing'` stamp when the claim ends WITHOUT
 * the turn having written any lifecycle state of its own — a throw before the
 * drive got going, or a drive that declined to take a turn after all. Guarded on
 * (still 'preparing') AND (still our scope), so it is a no-op the moment the turn
 * advanced the row (running/idle/parked/…) or a false-death reaper handed the run
 * to someone else. Without it, a declining claimant would release the scope and
 * leave the row stuck at 'preparing' with nothing driving it.
 */
async function restoreClaimedStatus(
  runId: number,
  scope: string,
  previousStatus: SessionStatus | null
): Promise<void> {
  if (!previousStatus) return;
  await db
    .update(agentSessions)
    .set({ status: previousStatus })
    .where(
      and(
        eq(agentSessions.id, runId),
        eq(agentSessions.status, "preparing"),
        eq(agentSessions.workerScope, scope)
      )
    );
}

/** Claim → drive one in-process turn → release (in finally). A lost claim race
 *  is a clean no-op (drive is skipped). Shared by create()'s in-process launch
 *  and dispatchRun's server-resume front door.
 *
 *  `drive` may return `false` to mean "claim won, but on a second look there is
 *  nothing to do" — the status stamped by the claim is then rolled back along
 *  with the release, so declining costs the run nothing (see wakeServerRun's
 *  post-claim re-check). Any other return value means the drive owned the turn
 *  and wrote its own landing. */
export async function withServerClaim(
  runId: number,
  drive: () => Promise<void | boolean>
): Promise<void> {
  const { claimed, scope, previousStatus } = await claimServerTurn(runId);
  if (!claimed) return;
  try {
    const drove = await drive();
    if (drove === false) await restoreClaimedStatus(runId, scope, previousStatus);
  } catch (err) {
    // A pre-drive read can fail before the turn writes its own lifecycle state.
    // Restore the state claimed from only while this exact claim still owns a
    // preparing row, before releasing the scope to any subsequent claimant.
    await restoreClaimedStatus(runId, scope, previousStatus);
    throw err;
  } finally {
    await releaseServerTurn(runId, scope);
  }
}

// ──────────────────────────────────────────────────────────
// Server-side dispatch/relay
// ──────────────────────────────────────────────────────────

/**
 * Make the worker channel usable before delivering a durable input.  This is
 * intentionally not a liveness gate: an alive process is dialled, and every
 * other verdict gets a fresh dispatch attempt.  `unknown` is conservative for
 * destructive reaping, but delivery is not destructive and must not be lost.
 */
export async function ensureWorkerConnected(runId: number): Promise<void> {
  const [instance] = await db
    .select({ instanceId: runnerInstances.channelInstanceId, incarnation: runnerInstances.workerIncarnation })
    .from(runnerInstances)
    .where(eq(runnerInstances.runId, runId));
  const liveness = await resolveLiveness(runId);
  if (liveness.verdict === "alive" && instance?.instanceId) {
    await runDispatch.startChannelForRun(runId, instance.instanceId);
    return;
  }

  // The observation was made outside this mutation.  Only discard an old claim
  // when the exact identity we observed is still recorded; this is the takeover
  // fence that prevents two controllers winning the replacement race.
  // Only a claim whose owner is OBSERVED gone is discarded; `alive` (without a
  // dialable channel) and `unknown` keep their claim.
  const run = await get(runId);
  if (run?.workerScope && liveness.verdict === "dead") {
    await db.update(agentSessions)
      .set({ workerScope: null })
      .where(and(
        eq(agentSessions.id, runId),
        eq(agentSessions.workerScope, run.workerScope),
        incarnationFence(runId, instance?.incarnation ?? null)
      ));
  }
  const result = await runDispatch.dispatchRun(runId);
  if (result === "spawn-failed") throw new Error(`could not start worker for run ${runId}`);
  if (result === "spawned" || result === "server-runtime") return;
  // "already-claimed" without a connected channel: the claim holder is
  // unreachable (unknown verdict, or alive but not dialable). Delivery must not
  // pretend to succeed — surface it so the caller reports a failure instead of
  // silently stranding the message (the run-181 wedge through another door).
  const registry = await import("./worker-channel/registry");
  if (!registry.getConnection(runId)?.connected) {
    throw new Error(`worker for run ${runId} holds the claim but is not reachable (${liveness.verdict})`);
  }
}

/**
 * Server-side entry for a user/system message. In the containerized model the
 * server runs as root and cannot run the agent turn, so it persists the message
 * (firing run_input to wake a live chat worker + run_stream for viewers), ensures
 * a worker is running (notify-if-live else dispatch), and RELAYS the reply from
 * the durable run_stream tail — yielding the SAME AppendStreamEvent frames the
 * in-process append() used to, so routes/UI are unchanged. Falls back to
 * in-process append() when there is no worker image (dev / non-containerized).
 */
export async function* sendMessageToRun(opts: {
  runId: number;
  role: "user" | "system";
  text: string;
  author?: string;
  abort: AbortController;
}): AsyncGenerator<AppendStreamEvent> {
  const { runId, role, text, author, abort } = opts;
  const run = await get(runId);
  if (!run) {
    yield { type: "error", error: `Run ${runId} not found` };
    return;
  }
  // Placement is a per-run property (design §3). A server-runtime run ALWAYS
  // takes the in-process streaming path, even on a deployment with a remote
  // runner configured — that is the whole point: persona chat turns must not
  // pay for a container. Worker-runtime rows keep the previous behavior exactly,
  // including the global fallback that lets a single-process dev server (no
  // remote runner) drive turns in-process for legacy/worker rows.
  //
  // isServerRuntimeRun, NOT `runtime === 'server'`: a legacy row carrying the
  // retired tier's placement together with a shell/fs/repo-write profile is
  // demoted to worker here, so it dispatches remotely exactly as it did before
  // M2 instead of being forced in-process (lib/run-runtime.ts).
  if (isServerRuntimeRun(run) || !runDispatch.remoteRunnerEnabled()) {
    yield* append({ runId, role, text, author, abort });
    return;
  }

  // Cursor BEFORE the insert so the relay captures exactly this turn's frames.
  const from = await streamCursor(runId);
  // FIX 2 (M5): keep the id of the row we just persisted. Because the cursor was
  // captured BEFORE this insert, a turn already in flight can slip its turn_done /
  // terminal marker into the stream ahead of our reply; the relay uses this id to
  // ignore any close marker that precedes our own user_message frame.
  const ownMsg = await persistMessage(runId, role, [{ type: "text", text }]);

  const workerIsolate = runDispatch.insideWorker() && runDispatch.nestedDispatchMode() === "isolate";
  const fresh = await get(runId);
  if (fresh) {
    if (run.goal === "<chat>") {
      try {
        await ensureWorkerConnected(runId);
        await bridgeToChannel(runId, "run.input", { messages: [{ id: ownMsg.id, role, content: [{ type: "text", text }] }] });
      } catch {
        yield* yieldDispatchFailure(runId);
        return;
      }
    } else {
      // BUG 4: one-agent-per-task on dispatch. A resumable (terminal) worktree run
      // re-driven by this follow-up must not join a DIFFERENT live run already on
      // the same task/canonical branch. Never blocks a task-less run, a <review>/
      // <execute> run (non-'worktree' cwd), or resuming THIS run's own in-flight
      // turn. The message we just persisted stays for whenever the run legitimately
      // resumes; here we refuse to spawn a rival agent.
      const rival = await findRivalTaskRun(run);
      if (rival != null) {
        yield {
          type: "error",
          error: `Task ${run.taskId} already has a live run (#${rival}); not resuming run ${runId} concurrently.`,
        };
        return;
      }
      // Non-chat follow-up: dispatch a single-turn worker. If the prior turn is
      // still in flight the claim is held and dispatchRun returns already-claimed
      // (harmless — that turn will resume onto this freshly persisted message).
      // Once the prior turn finished the worker released its claim, so this
      // dispatch now spawns a fresh worker to pick up the follow-up instead of
      // no-oping against a ghost claim forever.
      if (workerIsolate) {
        // Worker context (e.g. an executor's spawn__append_message): park the
        // child at 'pending' for the server to dispatch onto the child's OWN
        // Machine. Running this turn in-process would put the child's build
        // tooling inside the parent's Machine — the 2026-07-05 incident where
        // one typecheck OOM wedged the parent and every in-flight child.
        await deferRunForServerDispatch(runId, run.parentRunId ?? null);
      } else if ((await runDispatch.dispatchRun(runId)) === "spawn-failed") {
        // Dispatch failed synchronously (admission reject, spawn error): no
        // worker will ever write to the run stream, so relaying would hang the
        // caller forever (incident: the resume UI spun with no feedback).
        // Surface the recorded failure and end the stream.
        yield* yieldDispatchFailure(runId);
        return;
      }
    }
  }

  yield* relayRunStream(runId, from, abort, ownMsg.id);
}

/** Prompt for an unattended server-runtime wake: the turn was triggered by an
 *  inbox event (child.result, CI, a fired timer), not by a human message. The
 *  digest of those events is prefixed by append()'s claimInboxDigest, so this is
 *  only the "and now act on it" instruction. */
const SERVER_WAKE_PROMPT =
  "You were woken by the events above. Handle them and report back to the conversation.";

/**
 * Drive one in-process turn for a woken server-runtime run.
 *
 * A server-runtime run has no worker to dispatch to, so every wake that a
 * worker-runtime run would satisfy with dispatchRun (an inbox event's emit-time
 * wake, a fired timer, the pump's wake sweep) lands here instead — run-dispatch
 * routes it in dispatchRun(). The turn goes through append() so it shares the
 * per-run lock, the liveness lease, the inbox-digest claim and the postgres
 * context mode with a user-prompted turn; `persistUser: false` +
 * `ephemeralInput: true` keep the synthetic prompt out of the transcript and out
 * of the rebuilt model history (the digest frame append() claims IS the durable
 * record of the wake).
 *
 * Best-effort and quiet: nobody is streaming this turn. If the run is missing,
 * already in flight (a live lease, or an in-process runner), or hard-terminal,
 * it no-ops — the pump's wake sweep re-drives it on a later tick because the
 * pending inbox events stay pending.
 *
 * TWO no-op gates, both load-bearing (M2 review finding 2):
 *
 *  (b) NOTHING TO WAKE FOR. Every server-runtime wake is event-driven — an
 *      inbox emit, a fired timer's event, the pump's parked sweep over rows WITH
 *      pending events. When the run has no pending, non-control, owner/
 *      supervisor-audience event left, the wake has already been serviced: the
 *      emit-time wake and the ≤15s pump sweep both call dispatchRun, and the
 *      loser used to find the digest already claimed and burn a whole model turn
 *      on the bare SERVER_WAKE_PROMPT with no events attached. Check first, and
 *      no-op — a wake with nothing to say is not a turn.
 *
 *  (a) SOMEONE ELSE IS DRIVING. The isLive/isLeaseLive reads below are a
 *      snapshot; two processes (a pipe user turn and a web-process inbox wake,
 *      or two wakes) could both pass them and then both drive a turn,
 *      interleaving agent_messages. The turn is therefore taken under
 *      withServerClaim — the SAME worker_scope/heartbeat CAS dispatchRun's
 *      worker path uses (claimServerTurn stamps status='preparing' +
 *      'server-<nonce>' scope while worker_scope IS NULL). Exactly one caller
 *      wins; the loser returns without a turn. append() is then handed
 *      `takeover: true`, which is how a dispatched worker adopts the 'preparing'
 *      claim made for it — without it append's own isLeaseLive guard would
 *      reject the very claim we just took. append()'s heartbeat interval keeps
 *      the claim fresh for the whole turn, and withServerClaim releases the
 *      scope in a finally, so a user message arriving after the turn lands is
 *      never starved (and one arriving DURING it hits append's normal
 *      "already in flight" guard, as it would against any live turn).
 */
export async function wakeServerRun(runId: number): Promise<void> {
  const run = await get(runId);
  if (!run || !isServerRuntimeRun(run)) return;
  if (isLive(runId) || (await resolveLiveness(runId)).verdict === "alive") return;
  if (isTerminalStatus(run.status) && run.status !== "idle" && !isResumableRun(run)) return;
  // (b), cheap pre-check: no pending events ⇒ the wake was already serviced by a
  // racing driver. Advisory only — it saves a claim round-trip in the common
  // case; the AUTHORITATIVE check is the re-check below, inside the claim.
  if (!(await hasPendingInboxEvents(runId))) return;
  // (a): single-owner CAS. A lost race is a clean no-op — the winner's turn
  // drains the same pending events through its digest claim.
  await withServerClaim(runId, async () => {
    // (b) again, now that we hold the claim. The pre-check above is a snapshot:
    // a user turn or sibling wake could have claimed the digest in the window
    // between it and our CAS, in which case driving now would burn a whole model
    // turn on the bare SERVER_WAKE_PROMPT with no events attached — the exact
    // waste gate (b) exists to prevent. Returning false rolls the claim's
    // 'preparing' stamp back and releases the scope, so the run is left exactly
    // as we found it.
    if (!(await hasPendingInboxEvents(runId))) return false;
    for await (const ev of append({
      runId,
      role: "system",
      text: SERVER_WAKE_PROMPT,
      persistUser: false,
      ephemeralInput: true,
      takeover: true,
    })) {
      // Drain: append() persists everything it produces; the pipe/UI read the run
      // stream. An error frame is already recorded on the row by append().
      void ev;
    }
  });
}

/** Terminal error frame for a synchronous dispatch failure — the failure was
 *  recorded on the row by recordDispatchFailure (run-dispatch's failRun). */
async function* yieldDispatchFailure(runId: number): AsyncGenerator<AppendStreamEvent> {
  const failed = await get(runId);
  yield {
    type: "error",
    error: failed?.error ?? "Runner dispatch failed; see the run for details.",
  };
}

/**
 * Fork-resume for a plan executor: start a FRESH <execute> generation on the
 * prior run's plan. A replaced executor reconstructs progress from durable
 * state — list_tasks, child runs, task notes — so the new generation needs no
 * transcript from the old one (docs/agent-events.md §8); the kickoff prompt
 * carries a resume note naming the prior run and its landing so the agent
 * knows it is picking up mid-plan. Used by POST /api/sessions/[id]/resume,
 * whose implement-run path (agent.startSession) requires a taskId that
 * executors never have — the route used to 404 on every executor.
 *
 * Only a settled prior may be forked: a live/parked/idle executor resumes IN
 * PLACE via a message (sendMessageToRun/append), and a second generation
 * racing the first would double-dispatch children.
 */
export async function resumeExecutorRun(
  priorId: number,
  overrides: { model?: string | null; backend?: "pi" | "claude" | null } = {}
): Promise<RunRow> {
  const prior = await get(priorId);
  if (!prior) throw new repo.RepoError(`Run ${priorId} not found`, 404);
  if (prior.goal !== "<execute>" || !prior.planId) {
    throw new repo.RepoError(
      `Run ${priorId} is not a plan-executor run (goal=${prior.goal}); this resume path only forks executors.`,
      400
    );
  }
  if (!isTerminalStatus(prior.status)) {
    throw new repo.RepoError(
      `Executor run ${priorId} is still '${prior.status}' — send it a message to resume it in place instead of forking a new generation.`,
      409
    );
  }
  const note =
    `You are a fresh executor generation resuming plan ${prior.planId}: the prior executor ` +
    `run #${priorId} ended with status '${prior.status}'` +
    (prior.error ? ` (error: ${prior.error})` : "") +
    `. Reconstruct current progress from list_tasks, task notes, and child runs before ` +
    `starting any children, and never re-dispatch tasks that are already merged or in flight.`;
  return create({
    goal: "<execute>",
    planId: prior.planId,
    repoId: prior.repoId,
    personaId: prior.personaId ?? "executor",
    toolsProfile: prior.toolsProfile,
    // cwdStrategy deliberately NOT inherited: create() derives the executor
    // default ('repo'), and a legacy row carrying the column default
    // ('worktree') would otherwise trip the worktree-requires-taskId invariant.
    // An explicit override wins; otherwise inherit the prior generation's
    // model/backend (mirroring agent.startSession's resume inheritance).
    model: overrides.model ?? prior.model ?? undefined,
    backend: overrides.backend ?? prior.backend,
    thinkingLevel: prior.thinkingLevel,
    parentRunId: priorId,
    userId: prior.userId,
    title: prior.title,
    budget: {
      maxTurns: prior.budgetMaxTurns ?? undefined,
      maxUsd: prior.budgetMaxUsd ?? undefined,
      maxSeconds: prior.budgetMaxSeconds ?? undefined,
    },
    initialPrompt: note,
  });
}

/**
 * Tail the durable run_stream for one turn and translate rows into the exact
 * AppendStreamEvent wire shape (user_message | sdk | done | error) the message
 * routes already emit — so a worker-run turn streams to the browser byte-compatibly
 * with the old in-process path. Closes on a per-turn 'turn_done' marker (chat), a
 * terminal non-idle status (implement/one-shot), a 'failed' status, or abort.
 */
// Exported as a test seam (FIX 2 / M5): the cursor-gating behaviour is awkward to
// drive through sendMessageToRun (the `from` cursor is captured internally), so
// tests call this directly with a hand-crafted cursor + ownMsgId. Not part of the
// public API otherwise — sendMessageToRun is the only production caller.
export async function* relayRunStream(
  runId: number,
  from: { msgId: number; evtId: number },
  abort: AbortController,
  ownMsgId: number
): AsyncGenerator<AppendStreamEvent> {
  const { readStreamSince } = await import("./run-stream");
  const { subscribeRunStream } = await import("./run-stream-listener");
  let cursor = from;
  // FIX 2 (M5): the cursor was captured BEFORE our user message was persisted, so
  // a turn already in flight when sendMessageToRun ran can slip its turn_done /
  // failed / terminal marker into the stream ahead of our reply. Closing on that
  // marker finalizes the caller's draft with the WRONG turn's text. Gate every
  // close condition on having first seen our own user_message frame (ownMsgId):
  // only a marker AFTER our message belongs to our reply. Chat workers drain
  // oldest-first and emit exactly one turn_done per message, so the first marker
  // past our message is ours.
  let seenOwn = false;
  let pending = true; // drain once immediately
  let wake: (() => void) | null = null;
  const unsub = await subscribeRunStream(runId, () => {
    pending = true;
    wake?.();
    wake = null;
  });
  const onAbort = () => {
    wake?.();
    wake = null;
  };
  abort.signal.addEventListener("abort", onAbort);
  try {
    while (!abort.signal.aborted) {
      if (!pending) {
        // Wait for a NOTIFY wake or a 5s safety re-drain.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            wake = null;
            resolve();
          }, 5000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        if (abort.signal.aborted) break;
      }
      pending = false;
      const { frames, cursor: next, terminal } = await readStreamSince(runId, cursor);
      cursor = next;
      for (const f of frames) {
        if (f.kind === "message") {
          const r = f.message.role;
          // Our own user_message frame opens the gate: markers after it are ours.
          if (f.message.id === ownMsgId) seenOwn = true;
          if (r === "user" || r === "system") {
            yield { type: "user_message", message: f.message };
          } else if (r === "agent") {
            // Carry the persisted row alongside the envelope: the read-only
            // /events tail delivers the SAME row (keyed by DB id) to every
            // viewer including the sender, so without the id the client can't
            // dedup the two copies and renders the reply twice.
            yield {
              type: "sdk",
              sdk: { type: "assistant", message: { content: f.message.content } } as RunEnvelope,
              message: f.message,
            };
          } else if (r === "tool") {
            yield {
              type: "sdk",
              sdk: { type: "user", message: { content: f.message.content } } as RunEnvelope,
              message: f.message,
            };
          }
        } else {
          const d = f.data as { type?: string; status?: string; error?: string };
          if (d.type === "turn_done") {
            if (!seenOwn) continue; // a prior turn's marker — not our reply
            yield { type: "done" };
            return;
          }
          if (d.type === "status" && d.status === "failed") {
            if (!seenOwn) continue; // a prior turn's failure — not ours
            yield { type: "error", error: d.error ?? `Run ${runId} failed` };
            return;
          }
        }
      }
      // The readStreamSince `terminal` flag (a non-idle terminal status frame)
      // also only closes us once our own message has appeared.
      if (terminal && seenOwn) {
        yield { type: "done" };
        return;
      }
    }
  } finally {
    unsub();
    abort.signal.removeEventListener("abort", onAbort);
  }
}

interface OpenPrArgs {
  task: NonNullable<Awaited<ReturnType<typeof repo.getTask>>>;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  summary: string | null;
}

async function openPr({ task, branch, baseBranch, worktreePath, summary }: OpenPrArgs): Promise<string | null> {
  const title = `[${task.id}] ${task.title}`;
  const body = buildPrBody(task, summary);
  try {
    // The gh CLI used to infer owner/repo from the worktree's origin remote;
    // do the same, then open the PR in-process via Octokit.
    const remoteUrl = (await sh(["git", "remote", "get-url", "origin"], worktreePath)).trim();
    const or = ownerRepoFromRemote(remoteUrl);
    if (!or) {
      console.warn(`gh pr create failed: could not parse owner/repo from remote '${remoteUrl}'`);
      return null;
    }
    const { data } = await getOctokit().pulls.create({
      owner: or.owner,
      repo: or.repo,
      title,
      body,
      base: baseBranch,
      head: branch,
    });
    return data.html_url ?? null;
  } catch (err) {
    console.warn(`gh pr create failed: ${describe(err)}`);
    return null;
  }
}

async function armAutoMerge(prUrl: string, _worktreePath: string): Promise<string | null> {
  try {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      console.warn(`gh pr merge --auto failed: could not parse PR url '${prUrl}'`);
      return null;
    }
    // Auto-merge is a GraphQL-only mutation (no REST equivalent). Arm it with
    // the squash method, mirroring `gh pr merge --auto --squash`. Head-branch
    // deletion after merge follows the repo's auto-merge setting.
    const octokit = getOctokit();
    const { data: pr } = await octokit.pulls.get({
      owner: parsed.owner,
      repo: parsed.repo,
      pull_number: parsed.number,
    });
    await octokit.graphql(
      `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          clientMutationId
        }
      }`,
      { pullRequestId: pr.node_id, mergeMethod: "SQUASH" }
    );
    return "auto-merge armed";
  } catch (err) {
    console.warn(`gh pr merge --auto failed: ${describe(err)}`);
    return null;
  }
}

function buildPrBody(
  task: NonNullable<Awaited<ReturnType<typeof repo.getTask>>>,
  summary: string | null
): string {
  const sections: string[] = [];
  if (summary) sections.push(summary);
  else if (task.body.trim()) sections.push(task.body.trim());
  sections.push(`---`);
  sections.push(`Closes task **${task.id}**: ${task.title}.`);
  if (task.criteria.length > 0) {
    sections.push(
      `\n### Acceptance criteria\n` +
        task.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n")
    );
  }
  return sections.join("\n\n");
}

// ──────────────────────────────────────────────────────────
// One SDK turn (used by both implement worker and append)
// ──────────────────────────────────────────────────────────

interface RunOneTurnArgs {
  run: RunRow;
  cwd: string;
  prompt: string;
  abort: AbortController;
  author: string;
  onSdk?: (m: RunEnvelope) => void;
  /** Postgres-mode only: the prompt is a transient event-wake, not a persisted
   *  user row (so the loop must not rewrite a user row to embed it). */
  ephemeralInput?: boolean;
  /** Postgres-mode only: user-authored text before a transient event digest was
   *  prefixed to `prompt`; this is what belongs in persisted model history. */
  rawUserText?: string;
  /** Postgres-mode only: id of the persisted user row this turn processes; pins
   *  context override/annotation to that row when a backlog is drained. */
  inputMessageId?: number;
  /** Skip memory auto-recall for this turn WITHOUT touching `rawUserText` (which
   *  still drives what gets persisted). Set by append()'s PR-continuation loop:
   *  only the first turn of an append recalls against the user's message —
   *  continuations are orchestrator-authored re-prompts, and re-injecting the
   *  same block each iteration would just repeat it in the model's context. */
  suppressRecall?: boolean;
}

interface TurnResult {
  envelopes: RunEnvelope[];
  /** Persisted agent/tool row for each envelope that was written to
   *  agent_messages — lets append() stamp the real DB id onto its `sdk`
   *  frames so the client can dedup them against the /events tail. */
  persisted: Map<RunEnvelope, MessageRow>;
  summary: string | null;
  sdkSessionId: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number;
}

async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult> {
  const { run, cwd, prompt, abort, author, onSdk } = args;

  // Context mode follows placement (design §3). A worker-runtime run resumes an
  // SDK session file ('sdk-session'); a SERVER-runtime run rebuilds its
  // conversation from agent_messages every turn ('postgres',
  // lib/agent-backend/postgres-turn.ts) — so a persona chat survives a process
  // restart, needs no session file on disk, and never needs a worktree.
  //
  // Pi-only: claude-backend throws on contextSource='postgres'. create() rejects
  // a server-runtime run whose backend resolves to claude, so this AND is only
  // load-bearing for legacy rows (runtime='server' predates that check) — those
  // fall back to the SDK-session path rather than failing every turn.
  //
  // isServerRuntimeRun (not the raw column) is what keeps a legacy row with an
  // unsafe profile OUT of postgres mode: postgres mode deliberately skips the
  // sandbox and env-scrub interceptors below, which is only sound for a
  // tool-mediated profile. A demoted row takes the sdk-session path WITH those
  // interceptors, exactly as it did before M2.
  const usePostgres = isServerRuntimeRun(run) && resolveBackendId(run.backend) === "pi";

  const persona = await (await runTransport()).getPersona(run.personaId ?? "implementor");
  if (!persona) {
    throw new Error(
      `Persona '${run.personaId ?? "implementor"}' not found; ` +
      `seed personas via db/seed-personas.ts.`
    );
  }

  // The model is chosen per-run, not by the persona. The model picker emits
  // "provider/model-id"; a bare value (e.g. a legacy TASK_ORCH_AGENT_MODEL)
  // defaults to the anthropic provider.
  const rawModel = run.model ?? DEFAULT_MODEL;
  const { provider: resolvedProvider, id: resolvedModelId } =
    parseProviderQualifiedModel(rawModel);
  const profileSpec = run.toolsProfile ?? persona.toolsProfile;

  const profileCtx: ProfileContext = {
    runId: run.id, run, author, taskId: run.taskId, planId: run.planId, cwd,
  };
  const { factories: profileFactories } = await timeRunnerPhase(
    "profile_resolve",
    () => resolveProfiles(profileSpec, profileCtx),
    { provider: runnerProviderLabel(), fields: { runId: run.id, profileSpec } }
  );
  // Always-on extensions (docs/agent-events.md §7): the event/timer/result
  // tools mount regardless of tools_profile — no profile misconfiguration can
  // strand an agent without a way to park, report, or be woken.
  const alwaysOnFactories = await timeRunnerPhase(
    "extensions_always_on",
    () => alwaysOnExtensions(profileCtx),
    { provider: runnerProviderLabel(), fields: { runId: run.id } }
  );

  const sandboxDbPath = sandboxDbPathFor(run, cwd);
  const personaForExt = {
    id: persona.id,
    name: persona.name,
    description: persona.description ?? "",
    systemPrompt: persona.systemPrompt,
    thinkingLevel: (persona.thinkingLevel ?? undefined) as "low" | "medium" | "high" | "xhigh" | undefined,
    toolsProfile: persona.toolsProfile,
    skillPaths: [] as string[],
  };

  // Postgres-mode turns run in THIS server process with no worktree/cwd to
  // contain, and their tools execute directly (not through an SDK bash/file
  // hook), so the sandbox + env-scrub interceptors have nothing to guard — skip
  // them. Every other extension (persona prompt, memory, always-on events, the
  // profile factories incl. spawn) applies to both modes: the divergence that
  // used to exist (the lightweight loop wired its own bespoke tool set and prompt)
  // was the bug R3 removes.
  const extensions: Extension[] = [
    personaPromptFactory(personaForExt),
    personaMemoryFactory(personaForExt, run, cwd),
    modelWelfareFactory(personaForExt, run),
    ...(usePostgres
      ? []
      : [
          sandboxFactory(cwd, sandboxDbPath),
          // Registered unconditionally for every full-SDK run (worker AND
          // in-process server), regardless of persona/goal/backend/tools_profile —
          // see lib/agent-backend/env-scrub.ts for the incident this closes.
          // Listed after sandboxFactory: each interceptor prepends to the command
          // the prior one produced, and the interceptor chain executes outermost
          // (last-registered) prefix first, so `unset ...` runs before the
          // TASK_ORCH_DB export — though the two prefixes touch disjoint var sets,
          // so the order has no functional effect either way.
          envScrubFactory,
        ]),
    abortBridgeFactory(abort),
    ...alwaysOnFactories,
    ...profileFactories,
  ];

  const envelopes: RunEnvelope[] = [];
  const persisted = new Map<RunEnvelope, MessageRow>();
  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawFirstSdkEvent = false;
  let sdkCallStarted: bigint | null = null;

  // Persist each mapped envelope as the turn streams. The shape is identical
  // across backends (RunEnvelope), so downstream is backend-agnostic.
  // Assistant messages are written per-envelope (not batched at end-of-turn) so
  // a page load mid-turn — hours into a long executor run — replays the full
  // history from the DB instead of showing only tool results.
  const onEvent = async (env: RunEnvelope) => {
    if (!sawFirstSdkEvent && sdkCallStarted != null) {
      sawFirstSdkEvent = true;
      const firstEventMs = Number(process.hrtime.bigint() - sdkCallStarted) / 1_000_000;
      observeRunnerPhase("sdk_first_event", firstEventMs / 1000, {
        provider: runnerProviderLabel(),
        outcome: "success",
      });
      recordRunnerEvent("sdk_first_event", {
        provider: runnerProviderLabel(),
        runId: run.id,
        fields: {
          backend: backend.id,
          durationMs: firstEventMs,
          eventType: env.type,
        },
      });
    }
    envelopes.push(env);
    onSdk?.(env);

    if (env.type === "system" && env.subtype === "init" && env.session_id) {
      sdkSessionId = env.session_id;
      await (await runTransport()).patchRun(run.id, { sdkSessionId });
    }

    if (env.type === "assistant" && env.message?.content) {
      const blocks = env.message.content;
      if (blocks.length > 0) {
        persisted.set(env, await persistMessage(run.id, "agent", blocks as any));
      }
      const text = assistantText(blocks as SdkContentBlock[]);
      if (text) lastAssistantText = text;
    }

    if (env.type === "user" && env.message?.content) {
      const results = toolResults(env.message.content as SdkContentBlock[]);
      if (results.length > 0) {
        persisted.set(env, await persistMessage(run.id, "tool", results as any));
      }
    }

    if (env.type === "result") {
      if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
      inputTokens = env.usage?.input_tokens ?? inputTokens;
      outputTokens = env.usage?.output_tokens ?? outputTokens;
    }
  };

  // Per-run backend; a null column falls back to the deployment default.
  const requestedBackendLabel = run.backend ?? process.env.TASK_ORCH_AGENT_BACKEND ?? "pi";
  const backend = await timeRunnerPhase(
    "backend_load",
    () => getBackend(run.backend),
    { provider: runnerProviderLabel(), fields: { runId: run.id, backend: requestedBackendLabel } }
  );
  const backendId = backend.id;
  const resumeToken = run.sdkSessionId ?? null;

  // Postgres-mode context seam: the backend gets its DB access through these
  // callbacks so lib/agent-backend never imports `db`/runs.ts. loadMessages
  // returns the raw persisted rows (piMessage blobs preserved — the loop's
  // context reconstruction depends on them); annotateMessage rewrites the latest
  // user row to embed the pi Message metadata at turn start.
  const contextSource: ContextSource = usePostgres
    ? {
        kind: "postgres",
        runId: run.id,
        goal: run.goal,
        ephemeralInput: args.ephemeralInput === true,
        rawUserText: args.rawUserText,
        inputMessageId: args.inputMessageId,
        loadMessages: () => loadPostgresContextMessages(run.id),
        annotateMessage: async (id, content) => {
          await db
            .update(agentMessages)
            .set({ content: JSON.stringify(content) })
            .where(eq(agentMessages.id, id));
        },
      }
    : { kind: "sdk-session" };

  // Memory auto-recall (design §4): BM25-search every scope this run can see
  // with the user's inbound text and prepend the top hits to THIS turn's prompt.
  // Memory is pushed into context rather than left behind a tool the model may
  // forget to call.
  //
  // Placement rules, both context modes:
  //  • prompt text ONLY: it never becomes an agent_messages row. In postgres
  //    mode that means it reaches the model exactly once — the context is
  //    rebuilt from agent_messages every turn and the user row embeds
  //    `rawUserText`, NOT this prompt. On the sdk-session path the block is not
  //    persisted by US either, but the BACKEND session it is spoken into keeps
  //    it in its own history, so later resumed turns still see it. That is the
  //    same trade-off the inbox digest above already accepts on that path;
  //    bounded by INJECTED_MEMORY_LIMIT × INJECTED_BODY_CHARS.
  //  • only when there IS inbound user text: a bare event wake
  //    (ephemeralInput) or a synthetic kickoff/executor prompt has no user
  //    message to search with, and its digest already carries the context.
  //    `suppressRecall` covers the same idea for a re-prompt that reuses the
  //    original rawUserText (append()'s PR-continuation turns).
  //  • best-effort: a memory hiccup must never fail the user's turn.
  let promptWithMemory = prompt;
  const recallText =
    args.ephemeralInput === true || args.suppressRecall === true
      ? null
      : args.rawUserText?.trim() || null;
  if (recallText) {
    try {
      const recalled = await buildMemoryInjection({ run, text: recallText });
      if (recalled) promptWithMemory = `${recalled}\n\n${prompt}`;
    } catch {
      // recall is an optimization; the memory tools remain available
    }
  }

  const turnArgs = {
    cwd,
    contextSource,
    model: { provider: resolvedProvider, id: resolvedModelId },
    // Per-run reasoning level overrides the persona's; fall back to the
    // persona's (which may be unset, leaving the model default to apply).
    thinkingLevel: (run.thinkingLevel ?? persona.thinkingLevel ?? undefined) as
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | undefined,
    extensions,
    abort,
    prompt: promptWithMemory,
    onEvent,
  };
  // FIX 6 (M8): a resume token references state local to the container/worktree
  // that produced it (pi: a path under cwd; Claude: the HOME session store). When
  // a re-dispatch/recycle resumes into a FRESH container the token is dangling, so
  // the backend throws "session not found"-style. Rather than fail the whole run,
  // note the lost context and retry ONCE from scratch (resumeToken null) — the
  // prompt + checked-out code give the agent enough to continue. Never retry on an
  // abort (a cancel/interrupt aborted the turn deliberately), and only when we
  // actually had a token to resume. The pi backend's own existence check is
  // handled by another layer; this is the runs.ts-side safety net.
  let outcome;
  try {
    sdkCallStarted = process.hrtime.bigint();
    outcome = await timeRunnerPhase(
      "sdk_turn",
      () => backend.runTurn({ ...turnArgs, resumeToken }),
      { provider: runnerProviderLabel(), fields: { runId: run.id, backend: backendId, resume: !!resumeToken } }
    );
  } catch (err) {
    if (resumeToken && !abort.signal.aborted && isMissingSessionError(err)) {
      await persistMessage(run.id, "system", [
        {
          type: "text",
          text: `Previous session context could not be restored (${describe(err)}); continuing with a fresh session.`,
        },
      ]);
      sdkCallStarted = process.hrtime.bigint();
      outcome = await timeRunnerPhase(
        "sdk_turn_retry_fresh",
        () => backend.runTurn({ ...turnArgs, resumeToken: null }),
        { provider: runnerProviderLabel(), fields: { runId: run.id, backend: backendId } }
      );
    } else {
      throw err;
    }
  }

  // Cost/token accounting differs by context source. An SDK session reports a
  // RUNNING total for the whole resumed session on each result envelope, so the
  // finalize replaces run.* with the latest (outcome.*). A postgres-mode turn has
  // no session — outcome.* is JUST this turn's usage — so accumulate onto the
  // run's prior totals here, matching the old lightweight append accumulation (and
  // fixing the executor, which previously replaced and under-counted across wakes).
  const totalCostUsd = usePostgres
    ? accumulateCost(run.totalCostUsd, outcome.totalCostUsd)
    : outcome.totalCostUsd;
  const finalInputTokens = usePostgres
    ? accumulateCost(run.inputTokens, inputTokens ?? outcome.inputTokens)
    : (inputTokens ?? outcome.inputTokens);
  const finalOutputTokens = usePostgres
    ? accumulateCost(run.outputTokens, outputTokens ?? outcome.outputTokens)
    : (outputTokens ?? outcome.outputTokens);

  return {
    envelopes: envelopes as any,
    persisted,
    summary: summary ?? lastAssistantText ?? outcome.summary,
    // outcome.resumeToken is authoritative (backend-tagged); fall back to the
    // session id observed mid-turn, then the prior token.
    sdkSessionId: outcome.resumeToken ?? sdkSessionId ?? run.sdkSessionId ?? null,
    totalCostUsd,
    inputTokens: finalInputTokens,
    outputTokens: finalOutputTokens,
    turns: outcome.turns,
  };
}

/** Add a turn's usage/cost onto a run's prior total for postgres-mode turns
 *  (no SDK session carries a running total). A null turn value leaves the prior
 *  untouched; a null prior with a real turn value starts the accumulation. */
function accumulateCost(prior: number | null, turn: number | null): number | null {
  if (turn == null) return prior;
  return (prior ?? 0) + turn;
}

/**
 * Heuristic (FIX 6 / M8): does a thrown backend error indicate a missing/invalid
 * resume session rather than a transient failure we should surface? Resume tokens
 * point at per-container/worktree state that a fresh container can't find. We
 * require a session-ish noun AND not-found-ish wording so a live-session error
 * (e.g. a mid-turn stream failure) isn't misread as a dangling token.
 */
function isMissingSessionError(err: unknown): boolean {
  const msg = describe(err).toLowerCase();
  if (!/session|resume|conversation/.test(msg)) return false;
  // "no conversation found with session id" is the Claude CLI's exact wording
  // when a --resume transcript isn't on this machine's disk; it matches none of
  // the generic missing-ness phrases below ("found" without a preceding "not"),
  // which let the production failure slip past this net.
  return /not ?found|no (conversation|session) found|no such|missing|invalid|does ?n'?o?t ?exist|doesn'?t exist|unknown|cannot find|could not find|no longer|unrecogni[sz]ed|expired/.test(
    msg
  );
}

function checkBudget(run: RunRow, result: TurnResult): boolean {
  // Note: `turns` is counted per-backend (pi: turn_end events; Claude: the
  // result's num_turns), so a given budgetMaxTurns may behave slightly
  // differently across backends.
  if (run.budgetMaxTurns != null && result.turns >= run.budgetMaxTurns) return true;
  // Wall-clock cap: exhaust the run once the elapsed time since it started meets
  // or exceeds the configured budget. Checked at turn end (same cadence as
  // maxTurns), so an in-progress turn finishes and then the run lands
  // budget_exhausted rather than starting another.
  if (
    run.budgetMaxSeconds != null &&
    Date.now() - run.startedAt.getTime() >= run.budgetMaxSeconds * 1000
  ) {
    return true;
  }
  // Dollar cap. The budgetMaxUsd backstop must hold regardless of backend:
  //   - Claude backend: reports a cumulative total_cost_usd per session, which is
  //     authoritative — compare it directly (unchanged behavior).
  //   - pi backend: reports token *usage* but no priced cost (totalCostUsd is null
  //     or 0). Previously this left pi runs effectively uncapped on dollars — a
  //     resume/autofix loop could spend unbounded $. We now ESTIMATE the cost from
  //     this turn's token usage via a per-model pricing table (lib/pricing.ts) and
  //     enforce the same cap against the estimate.
  // The estimate is approximate (input/output list price only, no separate cache
  // pricing) so a tripped cap is "hit on an estimated basis". The estimate here is
  // per-turn; cross-turn resume loops stay bounded by budgetMaxTurns/budgetMaxSeconds
  // above. run.totalCostUsd is folded in as prior spend so that if a backend ever
  // records a running cost it accumulates rather than resetting each turn.
  if (run.budgetMaxUsd != null) {
    if (result.totalCostUsd != null && result.totalCostUsd > 0) {
      if (result.totalCostUsd >= run.budgetMaxUsd) return true;
    } else {
      const estimate = estimateCostUsd(run.model, result.inputTokens, result.outputTokens);
      if (estimate != null && (run.totalCostUsd ?? 0) + estimate >= run.budgetMaxUsd) {
        return true;
      }
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────
// Agent event system: producers + digest injection
// (docs/agent-events.md §3.1, §4, §6)
// ──────────────────────────────────────────────────────────

/**
 * Last assistant text emitted on a run (newest agent row with a non-empty text
 * block). Backstop for the implicit child.result synthesis (§4.2) when a child
 * completed without calling report_result. Deliberately replicated here (a
 * similar helper lives in lib/extensions/spawn.ts) — runs.ts must not import
 * from the extensions layer.
 */
export async function lastAgentText(runId: number): Promise<string | null> {
  const rows = await db
    .select({ content: agentMessages.content })
    .from(agentMessages)
    .where(and(eq(agentMessages.runId, runId), eq(agentMessages.role, "agent")))
    .orderBy(desc(agentMessages.id))
    .limit(50);
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const text = (parsed as Array<{ type?: string; text?: unknown }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

/**
 * The agent text a turn wrote AFTER a `streamCursor` snapshot, in order.
 *
 * The durable counterpart to the live event bus: a caller that snapshots
 * `streamCursor().msgId` before driving a turn can read back exactly what that
 * turn said, whether or not it heard a single envelope. Used by the pipe's
 * milestone wake, where the narration IS the deliverable — losing it because a
 * subscription attached late must not be possible (agent_messages is written
 * before the turn returns).
 *
 * Rows are joined the way the Discord transcript joins assistant blocks
 * (blank-line separated); tool-call summary lines have no durable equivalent
 * and are simply absent from this rendering.
 */
export async function agentTextAfter(runId: number, afterMessageId: number): Promise<string | null> {
  const rows = await db
    .select({ content: agentMessages.content })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.runId, runId),
        eq(agentMessages.role, "agent"),
        gt(agentMessages.id, afterMessageId)
      )
    )
    .orderBy(agentMessages.id)
    .limit(50);
  const parts: string[] = [];
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const text = (parsed as Array<{ type?: string; text?: unknown }>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (text) parts.push(text);
  }
  const joined = parts.join("\n\n").trim();
  return joined || null;
}

export interface TerminalChildEventSpec {
  type: "child.result" | "child.exception" | "child.cancelled" | "child.budget_exhausted";
  payload: Record<string, unknown>;
  dedupeKey: string;
}

/** A raise-tool payload persisted in agent_runs.result ({ code, ... }), or null. */
function asRaisePayload(result: unknown): Record<string, unknown> | null {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  return typeof r.code === "string" ? r : null;
}

/**
 * Pure builder for the terminal child event a run's landing status produces
 * (§3.1, §4.2). Returns null for non-terminal / 'closed' statuses (closing a
 * conversation is an archive action, not a child lifecycle fact). `lastText`
 * is only consulted for the implicit child.result synthesis.
 * Exported for unit tests.
 */
export function buildTerminalChildEvent(
  row: {
    id: number;
    status: string;
    attempt: number;
    result: unknown;
    error: string | null;
    prUrl: string | null;
    totalCostUsd: number | null;
    cwdStrategy: string;
  },
  lastText: string | null
): TerminalChildEventSpec | null {
  const base: Record<string, unknown> = { run_id: row.id, attempt: row.attempt };
  switch (row.status) {
    case "completed": {
      // report_result wrote a structured result this turn → trustworthy payload;
      // otherwise synthesize implicit:true with the last agent text (§4.2).
      const payload: Record<string, unknown> =
        row.result != null
          ? { ...base, result: row.result }
          : { ...base, implicit: true, summary: lastText };
      payload.pr_url = row.prUrl;
      payload.total_cost_usd = row.totalCostUsd;
      return { type: "child.result", payload, dedupeKey: `terminal:${row.id}:${row.attempt}` };
    }
    case "failed": {
      const raised = asRaisePayload(row.result);
      // Cheap recoverability judgment: a raise payload may carry its own
      // verdict; otherwise a failed worktree run is resumable (its branch and
      // worktree persist — isResumableWorktreeRun), everything else is not.
      const recoverable =
        raised && typeof raised.recoverable === "boolean"
          ? raised.recoverable
          : isResumableWorktreeRun("failed", row.cwdStrategy);
      const payload: Record<string, unknown> = raised
        ? { ...base, ...raised, recoverable }
        : { ...base, code: "unhandled", message: row.error ?? "run failed", recoverable };
      return { type: "child.exception", payload, dedupeKey: `terminal:${row.id}:${row.attempt}` };
    }
    case "cancelled":
      // Per-run singleton (§4.3): cancellation ends the run, not an attempt.
      return { type: "child.cancelled", payload: base, dedupeKey: `cancelled:${row.id}` };
    case "budget_exhausted":
      return {
        type: "child.budget_exhausted",
        payload: { ...base, spent_usd: row.totalCostUsd },
        dedupeKey: `terminal:${row.id}:${row.attempt}`,
      };
    default:
      return null;
  }
}

/**
 * Emit the terminal child event for a run's CURRENT status to its parent —
 * the one producer helper every terminal-status write site funnels through
 * (setStatus / setError / the turn-end paths / cancel). Best-effort by
 * construction: swallows every error, because event emission must never break
 * a status write. Dedupe (`terminal:<run>:<attempt>` / `cancelled:<run>`)
 * makes overlapping call sites idempotent.
 */
export async function emitTerminalChildEvent(runId: number): Promise<void> {
  try {
    const row = await get(runId);
    if (!row || row.parentRunId == null) return;
    const needsLastText = row.status === "completed" && row.result == null;
    const spec = buildTerminalChildEvent(row, needsLastText ? await lastAgentText(runId) : null);
    if (!spec) return;
    await emitInboxEvent({
      targetRunId: row.parentRunId,
      type: spec.type,
      payload: spec.payload,
      sourceKind: "run",
      sourceId: String(row.id),
      attempt: row.attempt,
      dedupeKey: spec.dedupeKey,
    });
    // Defuse the await_session backstop (§7): the parent armed a timeout timer
    // (correlationId `await-session:<child>`) when it parked on this child. Now
    // that the child is terminal the parent's wake is delivered by this event, so
    // cancel the timer — otherwise it fires a spurious `timer.fired` later.
    await cancelTimersByCorrelation(row.parentRunId, `await-session:${row.id}`).catch(() => {});
  } catch {
    // best-effort: never break the status write that triggered this
  }
}

/**
 * Emit `child.died` (§3.1) — the infrastructure failed; the agent never got
 * to speak. Called by handleWorkerDeath and by reconcileOrphanedRuns when it
 * fails a non-resumable orphan. Deduped per (run, worker scope) so the death
 * monitor and the reaper racing each other produce one event.
 */
async function emitChildDied(
  runId: number,
  info: { exitCode: number | null; oomKilled: boolean; scopeKey: string; resumable: boolean }
): Promise<void> {
  try {
    const row = (
      await db
        .select({
          parentRunId: agentSessions.parentRunId,
          attempt: agentSessions.attempt,
          workerLog: agentSessions.workerLog,
        })
        .from(agentSessions)
        .where(eq(agentSessions.id, runId))
    )[0];
    if (!row || row.parentRunId == null) return;
    const attempt = row.attempt ?? 1;
    await emitInboxEvent({
      targetRunId: row.parentRunId,
      type: "child.died",
      sourceKind: "run",
      sourceId: String(runId),
      attempt,
      dedupeKey: `died:${runId}:${info.scopeKey}`,
      payload: {
        run_id: runId,
        attempt,
        exit_code: info.exitCode,
        oom_killed: info.oomKilled,
        resumable: info.resumable,
        worker_log_tail: row.workerLog ? row.workerLog.slice(-2000) : null,
      },
    });
  } catch {
    // best-effort
  }
}

/**
 * Fresh turn-end read of the columns tools mutate mid-turn (§6.1 contract).
 *
 * MUST route through the transport, not `db` directly: the mutating tools
 * (timer__sleep / ask_parent / report_result / raise) execute server-side, so
 * an HTTP-mode worker can only observe their writes by reading back through the
 * transport — and a direct `db` read from a worker (which holds no DB access)
 * trips the guard in db/index.ts and fails the whole turn at the finish line.
 */
export async function readTurnEndState(
  runId: number
): Promise<{ status: SessionStatus; parkReason: string | null; result: unknown }> {
  const row = await (await runTransport()).getRun(runId);
  return {
    status: coerceRunStatus(row?.status ?? "running"),
    parkReason: row?.parkReason ?? null,
    result: row?.result ?? null,
  };
}

// The turn-end landing decision (decideTurnEndStatus), its input shape
// (TurnEndDecisionInput), and its result interpreters (isFailedResult /
// resultPrUrl) moved to lib/run-state.ts — the single owner of run status
// semantics. Imported above; re-exported here so the many `../lib/runs`
// consumers (tests, callers) keep working.
export type { TurnEndDecisionInput } from "./run-state";
export { decideTurnEndStatus, isFailedResult, resultPrUrl } from "./run-state";

/** The single typed content block a digest frame carries (§6.4). */
export interface EventDigestBlock {
  type: "event_digest";
  events: EventEnvelope[];
}

/**
 * Order claimed envelopes into the digest shape: owner events first (the ones
 * the run must ACT on), then the supervisor section (informational), each in
 * id (= emit) order. Pure; exported for unit tests.
 */
export function buildEventDigestBlock(envelopes: EventEnvelope[]): EventDigestBlock {
  const byId = (a: EventEnvelope, b: EventEnvelope) => a.event_id - b.event_id;
  const owner = envelopes.filter((e) => e.audience !== "supervisor").sort(byId);
  const supervisor = envelopes.filter((e) => e.audience === "supervisor").sort(byId);
  return { type: "event_digest", events: [...owner, ...supervisor] };
}

/**
 * Render a digest frame for the model. System-role agent_messages rows are not
 * fed back into the SDK prompt today, so the frame's data is ALSO rendered
 * into the turn's prompt text at prompt-build time (§6.4) — same data, two
 * surfaces. Pure; exported for unit tests.
 */
export function renderEventDigest(block: EventDigestBlock): string {
  const owner = block.events.filter((e) => e.audience !== "supervisor");
  const supervisor = block.events.filter((e) => e.audience === "supervisor");
  const line = (e: EventEnvelope) => {
    const src = `${e.source.kind}${e.source.id ? ` ${e.source.id}` : ""}`;
    const att = e.attempt != null ? `, attempt ${e.attempt}` : "";
    return `- [#${e.event_id}] ${e.type} (${src}${att}, ${e.occurred_at}): ${JSON.stringify(e.payload)}`;
  };
  const parts: string[] = [
    "## Inbox event digest",
    "New events were delivered to this run while it was parked or between turns.",
  ];
  if (owner.length > 0) {
    parts.push("", "### Addressed to you — act on these:", ...owner.map(line));
  }
  if (supervisor.length > 0) {
    parts.push(
      "",
      "### For your awareness (supervisor copies — informational; the owning run acts):",
      ...supervisor.map(line)
    );
  }
  return parts.join("\n");
}

/**
 * Digest injection (§6.4), the one turn-start consumer: claim pending inbox
 * events (owner + supervisor; control-class rows are excluded inside the claim
 * primitive), quarantine any poison event (§6.5), persist ONE agent_messages row
 * (role 'system') carrying a single event_digest block, stamp the claimed rows
 * with that frame id, and return the rendered digest text for the turn's prompt.
 * Returns null when nothing was claimable.
 *
 * PRECONDITION: the caller is inside the run's turn (per-run lock / owned
 * runner) — the same invariant the claim primitive documents.
 *
 * Atomicity (§6.4): the claim (pending→injected + claim-turn stamp), the poison
 * quarantine, and the digest-frame INSERT are ONE transaction — exactly-once into
 * the transcript. A crash (or a failed frame insert) between claim and persist
 * rolls the whole tx back, so the events stay 'pending' and the pump wake sweep
 * re-drives the turn; "claimed but never written anywhere" cannot exist. Runs
 * server-side only (workers reach it via the transport → db-transport), so direct
 * db/tx access is available.
 */
export async function injectPendingInboxEvents(runId: number): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      const claimed = await claimInboxEventsTx(tx, runId, { audiences: ["owner", "supervisor"] });
      // Platform notices (§6.6): control rows the platform already enforced
      // (markControlInjected) but that no digest has rendered yet. Unclaimable by
      // design; this is the one path that shows the model WHY its previous turn
      // ended. Read + stamped inside the same commit.
      const controlRows = await takeUnrenderedControlEvents(runId, tx);
      if (claimed.length === 0 && controlRows.length === 0) return null;
      const envelopes: EventEnvelope[] = [];
      for (const row of [...controlRows, ...claimed]) {
        try {
          envelopes.push(toEnvelope(row));
        } catch (err) {
          // Poison event (§6.5): quarantine (status→'error') in THIS tx and
          // proceed with the rest — the quarantine UPDATE never aborts the claim.
          await quarantineEvent(row.id, describe(err), tx);
        }
      }
      // All-poison (or empty): the tx still commits, so the quarantine marks
      // persist; nothing is rendered this turn.
      if (envelopes.length === 0) return null;
      const block = buildEventDigestBlock(envelopes);
      const [frame] = await tx
        .insert(agentMessages)
        .values({
          runId,
          role: "system",
          content: JSON.stringify([block]),
          createdAt: new Date(),
        })
        .returning({ id: agentMessages.id });
      await setClaimTurn(envelopes.map((e) => e.event_id), frame.id, tx);
      return renderEventDigest(block);
    });
  } catch {
    // Never block a turn on the inbox. On a mid-tx failure the claim rolled back,
    // so the events stay 'pending' and the pump wake sweep retries the turn.
    return null;
  }
}

/**
 * Single-transcript-representation guard (§6.4, §5.2): an inbox event lands in
 * agent_messages TWICE — an eager per-event `inbox_event` mirror at emit time
 * (mirrorInboxEventMessage), which the UI renders inline as events arrive, AND
 * the `event_digest` frame at claim time, which is the model-facing record. Only
 * ONE of them may reach the model. The digest is delivered to the model as prompt
 * TEXT (renderEventDigest, woven in by claimInboxDigest), so BOTH of these
 * system-role frames are excluded from the reconstructed model context here — the
 * mirror because it is a UI-only artifact, the digest because the model already
 * saw it as prompt text (re-feeding the frame would double it). Everything else
 * (user/agent/tool rows, plain system notices) passes through unchanged.
 */
function isModelContextExcludedSystemFrame(role: string, content: SdkContentBlock[]): boolean {
  if (role !== "system") return false;
  const first = content[0] as { type?: string } | undefined;
  return first?.type === "inbox_event" || first?.type === "event_digest";
}

/**
 * Load a run's persisted messages for the postgres-mode turn's context loader
 * (the `loadMessages` seam), id-ordered, with the inbox mirror/digest frames
 * excluded from model context (see isModelContextExcludedSystemFrame). Exported
 * so the exclusion is directly testable.
 */
export async function loadPostgresContextMessages(runId: number): Promise<
  Array<{ id: number; role: MessageRow["role"]; content: SdkContentBlock[]; createdAt: number }>
> {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId))
    .orderBy(asc(agentMessages.id));
  const out: Array<{ id: number; role: MessageRow["role"]; content: SdkContentBlock[]; createdAt: number }> = [];
  for (const row of rows) {
    let content: SdkContentBlock[] = [];
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed)) content = parsed as SdkContentBlock[];
    } catch {
      content = [{ type: "text", text: row.content }];
    }
    const role = (row.role as MessageRow["role"]) ?? "system";
    if (isModelContextExcludedSystemFrame(role, content)) continue;
    out.push({ id: row.id, role, content, createdAt: row.createdAt.getTime() });
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Persistence helpers
// ──────────────────────────────────────────────────────────

/**
 * Worker-channel input/cancel bridge (protocol plan section 8.4): when THIS
 * control plane holds a live channel to the run's worker, convert a durable DB
 * intent (new user message, cancel request) into the corresponding channel
 * command. Fire-and-forget by design — the durable row is the source of truth,
 * and a worker without a live channel is recovered by redispatch/reaper. The
 * worker's OrderedInputQueue dedupes by message id, so a message that also
 * reaches the worker via a start-snapshot replay is a benign duplicate.
 */
async function bridgeToChannel(
  runId: number,
  type: "run.input" | "run.cancel",
  payload: unknown,
  commandId?: string
): Promise<void> {
  try {
    // Callers make the worker reachable first (ensureWorkerConnected); the
    // bridge itself never dispatches, so one message costs one dispatch at most.
    const registry = await import("./worker-channel/registry");
    await registry.sendCommand(runId, type, payload, commandId);
  } catch {
    // Channel racing shutdown/replacement: the durable intent still lands via
    // snapshot replay or redispatch. Never let the bridge break the caller.
  }
}

async function persistMessage(
  runId: number,
  role: MessageRow["role"],
  content: SdkContentBlock[]
): Promise<MessageRow> {
  const row = await (await runTransport()).appendMessage(runId, role, content);
  if (role === "user") {
    void bridgeToChannel(
      runId,
      "run.input",
      { messages: [{ id: row.id, role: "user", content }] },
      `00000000-0000-4000-8000-${String(row.id).padStart(12, "0")}`
    );
  }
  return row;
}

async function setStatus(runId: number, status: SessionStatus) {
  // Terminal transitions are atomic + idempotent (the transport's applyStatus
  // also fires the child lifecycle event on a landed write). Non-terminal
  // transitions keep the cheap two-step write — there is no paired-event
  // atomicity to protect and a lost non-terminal mirror is self-healing.
  await (await runTransport()).setStatus(runId, status);
  recordStatusTransition(status);
  if (!isTerminalStatus(status)) {
    // The live-bus mirror for non-terminal transitions stays in THIS process —
    // it feeds in-process SSE subscribers of the turn being driven here.
    // (Terminal transitions emit inside applyStatusTx on a landed write.)
    runners.get(runId)?.bus.emit("event", { type: "status", status });
  }
}

// ──────────────────────────────────────────────────────────
// Cross-process cancel poll + orphan recovery
// ──────────────────────────────────────────────────────────

// LEASE_STATUSES ("a turn is in flight") lives in lib/types.ts — it is shared
// with the worker transport's claim-release guard and must not fork. Liveness
// itself is the provider verdict (lib/run-liveness.resolveLiveness); nothing
// here writes a clock.

/** How often a worker asks whether a cross-process cancel was requested. */
const CANCEL_POLL_INTERVAL_MS = 20_000;

function isProtocolMismatchError(err: unknown): boolean {
  // Keep runs.ts independent of the worker-side HTTP implementation (and its
  // class identity across bundles): the protocol error deliberately has a
  // stable name for this boundary.
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "ProtocolMismatchError";
}

function surfacePollFatal(err: unknown): void {
  // Interval callbacks have no awaiting caller. Escalate terminal poll failures
  // to the process safety net so a detached worker exits nonzero and the reaper
  // can replace its now-incompatible image.
  queueMicrotask(() => {
    throw err;
  });
}

function handlePollFailure(
  err: unknown,
  abort?: AbortController,
  onFatal: (err: unknown) => void = surfacePollFatal
): void {
  // Ordinary missed polls are tolerated; a wire-protocol mismatch is terminal.
  if (!isProtocolMismatchError(err)) return;
  if (abort && !abort.signal.aborted) abort.abort(err);
  onFatal(err);
}

/**
 * Fresh read of the cross-process cancel flag. cancel() sets `cancel_requested`
 * on the row; a detached worker (which can't see the web process's
 * AbortController) learns it via the poll (or the /control SSE push in HTTP
 * mode) and aborts its own turn. Kept as a direct read for the server-side
 * callers and tests that inspect the flag.
 */
export async function isCancelRequested(runId: number): Promise<boolean> {
  const row = (await db
    .select({ c: agentSessions.cancelRequested })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId)))[0];
  return row?.c === 1;
}

/**
 * Poll the cross-process cancel verdict for the active period of a turn and
 * abort it when the flag flips. Used by the workers a detached run process
 * executes in (append/runReview/runExecute) so a UI/`/stop` cancel — which only
 * writes the flag on the server — still stops the turn within one poll
 * interval. Without `abort` the poll only serves protocol-mismatch detection.
 * Returns the interval handle; the caller MUST clear it (in a finally).
 */
function startCancelPoll(
  runId: number,
  abort?: AbortController,
  onFatal: (err: unknown) => void = surfacePollFatal
): ReturnType<typeof setInterval> {
  // The interval body is async I/O; wrap it so a transient blip can't surface
  // as an unhandled rejection (which, with no global handler, can crash the
  // worker under Node's default).
  const poll = () => {
    void (async () => {
      const transport = await runTransport();
      const { cancelRequested } = await transport.pollCancel(runId);
      if (abort && cancelRequested && !abort.signal.aborted) {
        abort.abort();
        // Event system (§6.6): the abort IS the enforcement of the
        // run.cancel_requested control event — acknowledge its inbox row so
        // the next digest can show WHY the previous turn ended.
        void transport.ackCancel(runId).catch(() => {});
      }
    })().catch((err) => handlePollFailure(err, abort, onFatal));
  };
  poll();
  return setInterval(poll, CANCEL_POLL_INTERVAL_MS);
}

/** Narrow test seam; production callers use the defaults above. */
export const __cancelPollTest = { startCancelPoll };

/**
 * Repair a run whose in-flight turn was aborted. If cancel()/interrupt()/close()
 * already rewrote the row out of a lease status, we leave their terminal/idle
 * result alone. But a bare client-disconnect (req.signal → the append's abort)
 * aborts the turn with NO status rewrite, stranding the row in an active status
 * (it looks "in flight" forever and rejects every new message until the lease
 * goes stale). Repair that: chat/none runs return to `idle` (resumable next
 * message); everything else lands `failed`.
 */
async function repairAbortedRun(runId: number): Promise<void> {
  const cur = await get(runId);
  if (!cur) return;
  // Not in a lease status → cancel()/interrupt()/close() already handled it.
  if (!LEASE_STATUSES.includes(cur.status)) return;
  if (cur.goal === "<chat>" || cur.cwdStrategy === "none") {
    await (await runTransport()).patchRun(runId, { completedAt: null });
    await setStatus(runId, "idle");
  } else {
    await setError(runId, "Turn aborted before it finished (client disconnected).");
  }
}

/**
 * The status carried by a run's most recent `status` event (with its timestamp),
 * or null if it has none / the payload won't parse. reconcileOrphanedRuns uses
 * this to spot a run whose completion EVENT outlived a lost terminal column
 * write (see the guard below).
 */
async function latestEventStatus(
  runId: number
): Promise<{ status: string | null; at: Date } | null> {
  const rows = await db
    .select({ payload: agentEvents.payload, createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "status")))
    .orderBy(desc(agentEvents.id))
    .limit(1);
  if (!rows.length) return null;
  try {
    const status = (JSON.parse(rows[0].payload) as { status?: string }).status ?? null;
    return { status, at: rows[0].createdAt };
  } catch {
    return { status: null, at: rows[0].createdAt };
  }
}

/**
 * Demote runs left in an active status by a process that died mid-turn (e.g.
 * OOM-killed) — identified by a stale/absent heartbeat. Chat runs go back to
 * `idle` (resumable on the next message); others land `failed`. Safe to call on
 * every boot and concurrently across processes: a run genuinely live elsewhere
 * keeps its heartbeat fresh and is skipped. Returns the number reaped.
 */
export async function reconcileOrphanedRuns(): Promise<number> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.status, LEASE_STATUSES));
  let reaped = 0;
  for (const row of rows) {
    // A turn driven by THIS process is live by definition; never consult the DB for it.
    if (isLive(row.id)) continue;
    const [instance] = await db
      .select({ workerIncarnation: runnerInstances.workerIncarnation })
      .from(runnerInstances)
      .where(eq(runnerInstances.runId, row.id));
    const liveness = await resolveLiveness(row.id);
    if (liveness.verdict === "alive" || liveness.verdict === "unknown") {
      if (liveness.verdict === "unknown") console.warn(`[liveness] leaving run ${row.id} alone: provider observation unknown`);
      continue;
    }
    // BUG 6b: the SELECT above is a snapshot; a run can be re-claimed (re-dispatch
    // / worker adoption) between it and any write below. Every mutation on this row
    // is therefore conditioned on `stillOrphan` — a CAS (like handleWorkerDeath's
    // scope match) that the row is STILL in a lease status, STILL stale/absent
    // heartbeat, and STILL held by the SAME worker scope we snapshotted. A
    // re-claim stamps a fresh heartbeat (and a new scope), so it fails this guard
    // and we leave the row to its new owner instead of clobbering it.
    const incarnationCas = row.workerScope == null
      ? isNull(agentSessions.workerScope)
      : and(
          eq(agentSessions.workerScope, row.workerScope),
          incarnationFence(row.id, instance?.workerIncarnation ?? null)
        );
    const stillOrphan = and(
      inArray(agentSessions.status, LEASE_STATUSES),
      incarnationCas
    );
    // A completion EVENT can outlive a lost terminal column write: if the DB
    // drops the connection mid-finalize, emitStatus's event insert can land
    // while the paired `status='completed'` column update is rolled back,
    // stranding the row in a lease status even though the run actually finished
    // (and often already opened its PR). Failing it here would clobber real,
    // delivered work as "interrupted". When the run's MOST RECENT status event
    // says 'completed', honor that instead — a later 'running'/'preparing' event
    // means a genuine mid-turn orphan and falls through to the reap below.
    const lastEvent = await latestEventStatus(row.id);
    if (lastEvent?.status === "completed") {
      // Atomic status+event. Guard on `stillOrphan` (BUG 6b): a real finalize that
      // landed between our SELECT and here left a lease status (→ no clobber), but a
      // RE-DISPATCH that re-claimed to 'preparing' is ALSO a lease status — the old
      // lease-only guard would still fire 'completed' over that fresh claim. The
      // stale-heartbeat/scope CAS closes that window.
      const wrote = await applyStatusTx(row.id, "completed", {
        set: { error: null, completedAt: lastEvent.at },
        guard: stillOrphan,
        extra: { reconciled: true },
      });
      if (wrote) reaped++;
      continue;
    }
    // Detached mode: a worker that died mid-turn (host reboot / OOM) on a
    // resumable worktree run is handed to a fresh detached worker instead of
    // being failed. A worktree run is resumable — its branch/worktree persist
    // and it has an SDK session to resume from — so this mirrors
    // isResumableWorktreeRun's cwdStrategy="worktree" predicate (evaluated here
    // via isImplementWorktree, since the row is still in a *lease* status and
    // isResumableWorktreeRun only accepts post-reap terminal statuses). Clear
    // the stale claim first so dispatchRun can re-claim the row.
    // Remote runners (Fly Machines and Docker workers) re-clone from the branch
    // pushed to GitHub, so branch + SDK session is enough — the worktree lives
    // on the (dead/remote) worker, not here. On Fly especially, worktreePath is
    // a runner-Machine volume path (/mnt/session/repo) that NEVER exists on the
    // server, so an existsSync gate would wrongly fail every resumable orphan.
    // Host/dev mode still requires the on-disk worktree.
    const resumable = isResumableDeadRun({
      detached: runDispatch.detachedRunsEnabled(),
      remote: runDispatch.remoteRunnerEnabled(),
      isImplementWorktree: isImplementWorktree(row),
      hasSdkSession: !!row.sdkSessionId,
      hasBranch: !!row.branch,
      worktreeOnDisk: !!row.worktreePath && existsSync(row.worktreePath),
    });
    // A plan executor is resumable too, just not via the worktree predicate
    // above: its whole durable state lives in Postgres (plan/tasks/notes +
    // agent_messages + inbox). A worker-placement executor re-dispatches through
    // the worker's <execute> drive (gated on detached mode — without it there is
    // no dispatch machinery to hand the row to). Failing it with "Worker
    // heartbeat lost" after a deploy/restart killed its turn mid-flight abandons
    // a plan that can simply pick itself back up. Chat runs deliberately stay out
    // of this (their policy is already 'idle': the next user message resumes
    // them; an unattended auto-resume would burn a turn).
    const executorResumable =
      row.goal === "<execute>" && !!row.planId && runDispatch.detachedRunsEnabled();
    // The sweep has no OOM signal (it only sees a stale heartbeat), so oom=false:
    // a resumable orphan always re-dispatches here, exactly as before R8.
    // Server-runtime rows are never redispatched or failed by the reaper: they
    // have no worker whose death needs a policy, and "the process that was
    // driving this turn went away" (a web/pipe restart) is exactly the case the
    // 'idle' policy describes — the next inbound message or inbox wake resumes
    // them in-process. Failing them would kill a live Discord conversation on
    // every deploy; redispatching them would spawn a container for a run that
    // has no worktree to work in.
    const policy = isServerRuntimeRun(row)
      ? "idle"
      : decideDeadRunPolicy({
          goal: row.goal,
          resumable: resumable || executorResumable,
          oom: false,
        });
    // BUG 6b: atomically take this orphan out of any worker's hands before acting
    // on it — the shared ownership token, mirroring handleWorkerDeath's guarded
    // claim release. Clearing heartbeatAt too is what lets a redispatch actually
    // re-claim (dispatchRun's isLeaseLive guard would otherwise read the dead
    // worker's last beat as "still live"). If the CAS matches 0 rows the run was
    // re-claimed since our SELECT — leave it to its new owner without reaping.
    const claimed = await db.update(agentSessions)
      .set({ workerScope: null })
      .where(and(eq(agentSessions.id, row.id), stillOrphan))
      .returning({ id: agentSessions.id });
    if (claimed.length === 0) continue;
    if (policy === "redispatch") {
      void runDispatch.dispatchRun(row.id).catch(() => {});
      reaped++;
      continue;
    }
    if (policy === "idle") {
      await setStatus(row.id, "idle");
    } else {
      // §3.1: infra death the reaper is failing (non-resumable orphan) — emit
      // child.died with forensics, in addition to the child.exception the
      // setError below produces. Deduped per worker scope against the death
      // monitor racing this reap.
      void emitChildDied(row.id, {
        exitCode: null,
        oomKilled: false,
        scopeKey: row.workerScope ?? "lease",
        resumable: false,
      });
      // Say what we actually observed (the provider's verdict), not a guessed
      // cause — "process restart" sent incident debugging down the wrong path
      // more than once. Include the forensics we have: the verdict and its
      // detail, the worker scope (= container/sprite name), and any PR the run
      // delivered before dying.
      const observed = liveness.verdict === "dead"
        ? `worker ${liveness.reason}${liveness.detail ? `: ${liveness.detail}` : ""}`
        : "no worker claim";
      const delivered = row.prUrl ? ` Work delivered before the interruption: ${row.prUrl}` : "";
      await setError(
        row.id,
        `Worker gone — turn interrupted mid-flight (${observed}; scope ${row.workerScope ?? "none"}). ` +
          `The worker process or its runner died.${delivered}`
      );
    }
    reaped++;
  }
  if (reaped > 0) console.log(`[runs] reconciled ${reaped} orphaned run(s)`);
  return reaped;
}

/**
 * Apply the worker-death policy to a run whose container Docker reports dead
 * (die event or reconcile sweep — see lib/run-dispatch's worker monitor). Same
 * policy as reconcileOrphanedRuns, applied the moment the container dies instead
 * of after the 5-minute heartbeat timeout:
 *   - superseded / already-finished / parked runs: nothing to do
 *   - chat runs go back to `idle` (the next message re-dispatches a worker)
 *   - resumable implement runs are re-dispatched — EXCEPT when the container was
 *    OOM-killed: the same memory cap will kill the retry at the same spot, so a
 *    visible failure beats a silent kill loop
 *   - everything else lands `failed` with the exit code, pointing at the
 *     captured worker log
 */
export async function handleWorkerDeath(
  runId: number,
  info: {
    exitCode: number | null;
    oomKilled: boolean;
    containerName: string;
    /** The incarnation the caller observed dead (null = none stored). Omit to fence on the stored value. */
    incarnation?: string | null;
  }
): Promise<void> {
  const row = await get(runId);
  if (!row) return;
  // Only the run's CURRENT container may decide its fate — a stale container
  // from a superseded claim (the run was re-dispatched) must not touch it.
  if (row.workerScope !== info.containerName) return;
  if (isTerminalStatus(row.status)) return; // finished before/while dying — normal exit
  if (row.status === "pending") return; // claim already released (deferred)

  // Atomically take ownership of this death: release the claim ONLY if this
  // container still holds it. This is the real guard (the read above is just a
  // snapshot): if a concurrent death handler or a re-dispatch already moved on,
  // the row count is 0 and we do nothing. Clearing heartbeatAt too is what lets
  // the re-dispatch below actually re-claim — dispatchRun's isLeaseLive guard
  // treats a fresh heartbeat (the dead worker's last beat, ≤20s old) as "still
  // live" and would otherwise no-op the re-dispatch, stranding the run until the
  // 5-minute reaper.
  // worker_scope alone is NOT a fence on sprites (the sprite name is stable
  // across incarnations), so also fence on the incarnation the caller observed —
  // or, failing that, the one stored when we started.
  const observedIncarnation = info.incarnation !== undefined
    ? info.incarnation
    : (await db.select({ i: runnerInstances.workerIncarnation }).from(runnerInstances).where(eq(runnerInstances.runId, runId)))[0]?.i ?? null;
  const released = await db
    .update(agentSessions)
    .set({ workerScope: null })
    .where(and(
      eq(agentSessions.id, runId),
      eq(agentSessions.workerScope, info.containerName),
      incarnationFence(runId, observedIncarnation)
    ));
  if (released.count === 0) return; // lost the race — another handler owns it

  // Parked chat run whose worker wound down (idle timeout): the claim release
  // above is the whole job — it's already resumable on the next message.
  if (row.status === "idle") return;

  const oom = info.oomKilled || info.exitCode === 137;
  const why =
    info.exitCode == null
      ? "its container is gone"
      : `its container exited with code ${info.exitCode}${oom ? " — killed at its memory cap (OOM)" : ""}`;

  // Existence gate reconciled with reconcileOrphanedRuns (R8): both pass
  // `remote = remoteRunnerEnabled()`. In this Docker-die context WORKER_IMAGE is
  // set and remoteRunnerEnabled() reduces to its presence (given detached), so
  // this preserves the old `!!TASK_ORCH_WORKER_IMAGE` gate; on Fly it is now also
  // correct (branch check, not the never-present server worktree path).
  const worktreeResumable = isResumableDeadRun({
    detached: runDispatch.detachedRunsEnabled(),
    remote: runDispatch.remoteRunnerEnabled(),
    isImplementWorktree: isImplementWorktree(row),
    hasSdkSession: !!row.sdkSessionId,
    hasBranch: !!row.branch,
    worktreeOnDisk: !!row.worktreePath && existsSync(row.worktreePath),
  });
  // Same carve-out as reconcileOrphanedRuns: a plan executor's whole state
  // lives in Postgres, so it resumes cleanly regardless of worktree/branch —
  // without this, a dead executor routed here (e.g. via the container sweep)
  // lands `failed` instead of re-dispatched. Worker-placement executors need
  // detached mode (the dispatch machinery) to be re-handed to a fresh worker.
  const executorResumable =
    row.goal === "<execute>" && !!row.planId && runDispatch.detachedRunsEnabled();
  const resumable = worktreeResumable || executorResumable;
  // §3.1: durable infra-death fact for the parent, whatever policy follows
  // below (re-dispatch / idle / failed). Deduped per container so the events
  // monitor and the sweep racing each other produce ONE event, not two.
  void emitChildDied(runId, {
    exitCode: info.exitCode,
    oomKilled: oom,
    scopeKey: info.containerName,
    resumable,
  });
  // Unlike the sweep, the Docker-die handler has a real OOM verdict — pass it, so
  // an OOM-killed resumable run FAILS (a re-dispatch would be re-killed at the
  // same cap) rather than looping.
  const policy = decideDeadRunPolicy({ goal: row.goal, resumable, oom });
  if (policy === "redispatch") {
    // AWAIT the re-dispatch: its atomic claim (status→preparing, fresh heartbeat)
    // must land before this pump tick's later reconcileOrphanedRuns pass runs, or
    // that pass would see a lease-status row with a null heartbeat, judge it an
    // orphan, and re-dispatch it a SECOND time.
    await runDispatch.dispatchRun(runId).catch(() => {});
    return;
  }
  if (policy === "idle") {
    await setStatus(runId, "idle");
    return;
  }
  await setError(
    runId,
    `Worker died before finishing — ${why}. Check the worker log on this run for details.`
  );
}

/**
 * The captured worker-container log for a run. Kept OFF RunRow on purpose: the
 * tail can be 64KB and RunRow feeds list endpoints. Null result = no such run.
 */
export async function getWorkerLog(
  runId: number
): Promise<{ log: string | null; exitCode: number | null; scope: string | null } | null> {
  const [row] = await db
    .select({
      log: agentSessions.workerLog,
      exitCode: agentSessions.workerExitCode,
      scope: agentSessions.workerScope,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId));
  if (!row) return null;
  return { log: row.log ?? null, exitCode: row.exitCode ?? null, scope: row.scope ?? null };
}

/**
 * Runs in a lease status that hold a worker claim — the sweep cross-checks these
 * against the containers that actually exist.
 */
export async function listLeasedRuns(): Promise<RunRow[]> {
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(inArray(agentSessions.status, LEASE_STATUSES), isNotNull(agentSessions.workerScope)));
  return rows.map(hydrateRun);
}

/**
 * Count runs currently occupying a detached-worker slot: runtime='worker', a
 * non-null worker_scope, and a fresh heartbeat. Status is deliberately ignored:
 * a resident chat worker remains charged while idle.
 */
export async function countInFlightWorkers(): Promise<number> {
  // Count runs a LIVE worker owns — worker_scope set AND a fresh heartbeat —
  // regardless of status. A long-lived chat worker parked at 'idle' between turns
  // still holds a resident container + its memory, so it must count against the
  // admission budget; a dead worker's stale claim (expired heartbeat) must not.
  // Placement is decided by the isServerRuntimeRun predicate, not the raw
  // column: a demoted legacy row (server placement + unsafe profile) really does
  // get a container, so it must be charged for one — while a true server-runtime
  // turn holds a 'server-<nonce>' worker_scope with no container behind it and
  // must not be. Hence the widened SQL + predicate filter.
  const rows = await db
    .select({
      id: agentSessions.id,
      runtime: agentSessions.runtime,
      toolsProfile: agentSessions.toolsProfile,
    })
    .from(agentSessions)
    .where(
      and(
        inArray(agentSessions.runtime, ["worker", "server"]),
        isNotNull(agentSessions.workerScope)
      )
    );
  let count = 0;
  for (const row of rows) {
    if (isServerRuntimeRun(row)) continue;
    const v = (await resolveLiveness(row.id)).verdict;
    if (v === "alive" || v === "unknown") count++; // an unobservable worker still occupies its slot
  }
  return count;
}

const pendingParent = alias(agentSessions, "pending_parent");

/**
 * Ids of runs parked in 'pending' (the dispatch queue). A run sits here either
 * freshly created (awaiting its kickoff dispatch) or deferred by the admission
 * gate for lack of host capacity; the pending-run pump re-dispatches them.
 *
 * Ordering: pending runs whose PARENT holds a live worker claim come first
 * (oldest-first among themselves), then every other pending run, oldest-first.
 * This is NOT just a fairness nicety — dispatchRun's deadlock breaker (see the
 * "Deadlock breaker (M1)" comment there) admits exactly this set of children
 * over the cap, so they can never come back as "deferred". The pump
 * (pumpTick) stops at the FIRST deferred result, on the assumption that a
 * defer means the host is full and later ids won't fare better either. A
 * deferred ROOT run sitting ahead of a breaker-eligible child in id order
 * would trip that early break and starve the child until
 * TASK_ORCH_MAX_DEFER_MS fails it — even though the child was always
 * dispatchable. Serving breaker-eligible children first means the pump only
 * ever hits its early break on the plain root-run tail, where "stop at the
 * first defer" is actually true.
 */
export async function listPendingRunIds(): Promise<number[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      runtime: agentSessions.runtime,
      toolsProfile: agentSessions.toolsProfile,
      parentWorkerScope: pendingParent.workerScope,
      parentId: pendingParent.id,
    })
    .from(agentSessions)
    .leftJoin(pendingParent, eq(agentSessions.parentRunId, pendingParent.id))
    // Worker-runtime rows only: this IS the dispatch queue (admission, host
    // memory, worker slots), and a server-runtime run never occupies any of
    // that — it is driven by inbound messages and inbox-event wakes, not by the
    // pump. (Its own wake belt is pumpTick's parked sweep, which routes through
    // dispatchRun's server-runtime branch.)
    //
    // The placement filter is the isServerRuntimeRun PREDICATE, applied below
    // rather than as a `runtime = 'worker'` SQL clause: a legacy row with a
    // server placement and an unsafe profile is a worker row for every purpose,
    // and must get the pump belt back (retry AND the max-defer failer) instead
    // of sitting at 'pending' forever with no tier watching it. The pending
    // queue is small, so the extra rows cost nothing.
    .where(and(eq(agentSessions.status, "pending"), inArray(agentSessions.runtime, ["worker", "server"])))
    .orderBy(asc(agentSessions.id));

  const liveParentChildren: number[] = [];
  const rest: number[] = [];
  for (const r of rows) {
    if (isServerRuntimeRun(r)) continue;
    const parentLive = r.parentId != null && (await resolveLiveness(r.parentId)).verdict === "alive";
    (parentLive ? liveParentChildren : rest).push(r.id);
  }
  return [...liveParentChildren, ...rest];
}

// ──────────────────────────────────────────────────────────
// Atomic run finalize (Tier 1)
// ──────────────────────────────────────────────────────────
//
// Incident: a terminal transition was written as TWO statements — a status
// column UPDATE on agent_runs, then a paired status-event INSERT (emitStatus).
// Under DB pressure a worker's connection died BETWEEN them: the event landed
// but the column write was lost, so the orphan reaper mislabeled a finished run
// (PR already delivered) as `failed`. applyStatusTx makes the column write and
// its paired event ONE transaction (both-or-neither) and idempotent: a guard
// that matches 0 rows means the run is already finalized → no event, no throw.

// TERMINAL_STATUSES (the terminal-write idempotency guard) and
// buildStatusEventValues (the status-event row shape) moved to lib/run-state.ts
// and are imported at the top of this module.

/** How many times a worker retries a transient-failed finalize before giving up,
 *  and the per-attempt backoff. Kept snappy — a single-turn worker is about to
 *  exit, so we spend at most a few seconds re-acknowledging the transition. */
const FINALIZE_RETRIES = 3;
const FINALIZE_BACKOFF_MS = [500, 1000, 2000];

/**
 * Retry `fn` while it fails with a transient network/DB error (connection reset
 * mid-commit, socket hang up). Because applyStatusTx is atomic AND guarded, a
 * retry after an AMBIGUOUS failure (the tx actually committed but the ack was
 * lost) re-runs the guarded UPDATE, matches 0 rows, and returns `false` — the
 * run IS finalized, so the caller treats false as success. Non-transient errors
 * (a real bug, the rollback test's forced INSERT failure) propagate immediately.
 */
export async function finalizeWithRetry<T>(fn: () => Promise<T>, retries = FINALIZE_RETRIES): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientNetworkError(err) || attempt >= retries) throw err;
      const backoff = FINALIZE_BACKOFF_MS[Math.min(attempt, FINALIZE_BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

type StatusTxOpts = {
  /** Extra columns to write alongside status (error, completedAt, tokens, …). */
  set?: Partial<typeof agentSessions.$inferInsert>;
  /** Extra WHERE conditions ANDed with eq(id) — the CAS/idempotency guard. */
  guard?: SQL | undefined;
  /** Extra fields folded into the status event payload (e.g. { error }). */
  extra?: Record<string, unknown>;
  /** When set, retry the tx on a transient DB error this many times (worker paths). */
  retries?: number;
};

/**
 * Write a status transition and its paired status event as ONE transaction.
 * Returns true if the row was written (event inserted), false if the guard
 * matched 0 rows (already finalized — an idempotent no-op, NOT an error).
 *
 * The event INSERT is NOT swallowed: if it fails the whole tx aborts and the
 * column write rolls back too — both-or-neither, which is the entire point. The
 * live-bus emit and the child-lifecycle event fire only AFTER a successful
 * commit and stay OUTSIDE the tx (they are side effects that must not be
 * replayed if the tx retries/rolls back).
 */
export async function applyStatusTx(
  runId: number,
  status: SessionStatus,
  opts: StatusTxOpts = {}
): Promise<boolean> {
  const where = opts.guard
    ? and(eq(agentSessions.id, runId), opts.guard)
    : eq(agentSessions.id, runId);
  // Captured inside the tx (the status the row held before this write) so the
  // legal-transition check can run against it once, AFTER commit — warning +
  // telemetry are side effects that must not replay on a finalizeWithRetry.
  let fromStatus: SessionStatus | undefined;
  const run = (): Promise<boolean> =>
    db.transaction(async (tx) => {
      const before = await tx
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, runId))
        .limit(1);
      fromStatus = before[0] ? coerceRunStatus(before[0].status) : undefined;
      const written = await tx
        .update(agentSessions)
        .set({ status, ...(opts.set ?? {}) })
        .where(where)
        .returning({ id: agentSessions.id });
      if (written.length === 0) return false; // already finalized → no event
      if (isTerminalStatus(status)) {
        await tx
          .update(runTimers)
          .set({ status: "cancelled" })
          .where(and(eq(runTimers.runId, runId), eq(runTimers.status, "pending")));
      }
      await tx.insert(agentEvents).values(buildStatusEventValues(runId, status, opts.extra));
      return true;
    });
  const committed = opts.retries ? await finalizeWithRetry(run, opts.retries) : await run();
  if (committed) {
    // Make the state machine visible: an edge the transition table does not
    // sanction is WARNED + counted, never rejected (this phase does not enforce).
    if (fromStatus) assertTransition(fromStatus, status, recordIllegalTransition);
    recordStatusTransition(status);
    runners.get(runId)?.bus.emit("event", { type: "status", status, ...(opts.extra ?? {}) });
    // Child lifecycle producer (§3.1): any terminal transition on a child run
    // becomes a durable inbox event for its parent. Deduped per (run, attempt).
    if (isTerminalStatus(status)) void emitTerminalChildEvent(runId);
  }
  return committed;
}

/**
 * Atomically fail a run still parked in 'pending' with no worker claim — the
 * dispatch pump's max-defer-exceeded transition (was a raw CAS UPDATE followed
 * by a separate failRun, i.e. two writes for one transition). Guarded exactly as
 * the original CAS was: a dispatch that claimed the row in the meantime owns it,
 * so this write must not clobber a healthy claim into 'failed'. Returns true iff
 * the row was actually failed (and its event emitted).
 */
export async function failPendingRun(runId: number, error: string): Promise<boolean> {
  return applyStatusTx(runId, "failed", {
    set: { error, completedAt: new Date() },
    guard: and(eq(agentSessions.status, "pending"), isNull(agentSessions.workerScope)),
    extra: { error },
  });
}

export async function setError(runId: number, error: string, opts?: { retries?: number }) {
  // Idempotent: the terminal guard makes a second setError on an already-failed
  // (or completed/cancelled) run a no-op — no re-fired event, no error overwrite.
  // reconcileOrphanedRuns only ever calls this on LEASE_STATUSES rows, so the
  // guard never blocks a legitimate reap. emitTerminalChildEvent is fired inside
  // the landing write, gated on it actually landing. Routed through the
  // transport: setError runs on worker exit paths, which in HTTP mode must not
  // touch the DB.
  await (await runTransport()).applyStatus(runId, "failed", {
    set: { error, completedAt: new Date() },
    guard: "not-terminal",
    extra: { error },
    retries: opts?.retries,
  });
}

/**
 * Record a DISPATCH failure (admission reject, tree-limit violation, provider
 * spawn error). Unlike setError — whose terminal guard makes it a no-op on an
 * already-terminal row — a re-dispatch of a resumable FAILED run (a user
 * resuming it) must still surface WHY this attempt failed: past incidents
 * resumed into an admission reject whose message vanished behind the previous
 * attempt's stale error, and the stream relay hung with nothing to show.
 * For a row already 'failed', refresh the error text in place (status
 * unchanged, cancelled/closed and other statuses untouched).
 */
export async function recordDispatchFailure(runId: number, error: string): Promise<void> {
  await setError(runId, error);
  const [row] = await db
    .select({ status: agentSessions.status, error: agentSessions.error })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId));
  if (row?.status === "failed" && row.error !== error) {
    await db
      .update(agentSessions)
      .set({ error, completedAt: new Date() })
      .where(and(eq(agentSessions.id, runId), eq(agentSessions.status, "failed")));
    await emitStatus(runId, "failed", { error });
  }
}

async function emitStatus(runId: number, status: SessionStatus, extra?: Record<string, unknown>) {
  // Non-terminal / best-effort mirror to agent_events (legacy /sessions UI).
  // Terminal transitions go through applyStatusTx instead, where the event is
  // transactional; here the insert is swallowed because a lost non-terminal
  // mirror is harmless (the next transition re-establishes state).
  try {
    await db.insert(agentEvents).values(buildStatusEventValues(runId, status, extra));
  } catch {
    // ignore event mirror failures
  }
  runners.get(runId)?.bus.emit("event", { type: "status", status, ...(extra ?? {}) });
}

function closeBus(runId: number) {
  const r = runners.get(runId);
  if (!r) return;
  r.bus.emit("done");
  r.bus.removeAllListeners();
  runners.delete(runId);
}

// ──────────────────────────────────────────────────────────
// Subscriptions (for SSE consumers)
// ──────────────────────────────────────────────────────────

export function subscribe(runId: number, listener: (event: unknown) => void): () => void {
  const bus = runners.get(runId)?.bus;
  if (!bus) return () => {};
  bus.on("event", listener);
  return () => bus.off("event", listener);
}

/**
 * Subscribe to a run's events WITHOUT having to wait for it to be live.
 *
 * `subscribe` above can only attach to a bus that already exists, which forces
 * callers that drive a turn themselves (the pipe's milestone wake) into a poll
 * loop: kick the turn, then wait for isLive() and subscribe. That loop loses
 * every envelope of a turn that starts and finishes inside one poll interval —
 * silently, since the turn itself succeeds. This variant attaches immediately
 * when the run is live and otherwise parks the listener until the run's runner
 * registers (registerRunner), so "subscribe first, then wake" is race-free.
 *
 * The returned unsubscribe detaches from both places and must always be called:
 * a parked listener is only dropped by it.
 */
export function subscribeRunEvents(
  runId: number,
  listener: (event: unknown) => void
): () => void {
  runners.get(runId)?.bus.on("event", listener);
  let waiting = pendingSubscribers.get(runId);
  if (!waiting) {
    waiting = new Set();
    pendingSubscribers.set(runId, waiting);
  }
  waiting.add(listener);
  return () => {
    runners.get(runId)?.bus.off("event", listener);
    const set = pendingSubscribers.get(runId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) pendingSubscribers.delete(runId);
  };
}

export function isLive(runId: number): boolean {
  return runners.has(runId);
}

/**
 * Best-effort push of an arbitrary event onto a run's live bus. No-op when the
 * run isn't currently in flight (the bus only exists during a turn) — durable
 * delivery is the caller's responsibility (e.g. an agent_events row). Used by
 * the GitHub webhook handler to surface CI/PR feedback to a connected SSE
 * client in real time.
 */
export function emitRunEvent(runId: number, type: string, payload: unknown): void {
  runners.get(runId)?.bus.emit("event", { type, payload });
}

// ──────────────────────────────────────────────────────────
// Hydration
// ──────────────────────────────────────────────────────────

export function hydrateRun(row: typeof agentSessions.$inferSelect): RunRow {
  return {
    id: row.id,
    goal: row.goal,
    // Defensive: a legacy/unknown status string is mapped into the current
    // vocabulary rather than blindly cast (coerceRunStatus in lib/run-state.ts).
    status: coerceRunStatus(row.status),
    origin: row.taskId !== null ? "task" : "chat",
    taskId: row.taskId,
    planId: row.planId,
    repoId: row.repoId,
    parentRunId: row.parentRunId,
    toolsProfile: row.toolsProfile,
    cwdStrategy: row.cwdStrategy as CwdStrategy,
    runtime: (row.runtime as "server" | "worker" | null) ?? "worker",
    model: row.model,
    backend: (row.backend as "pi" | "claude" | null) ?? null,
    thinkingLevel: (row.thinkingLevel as "low" | "medium" | "high" | "xhigh" | null) ?? null,
    branch: row.branch,
    worktreePath: row.worktreePath,
    prUrl: row.prUrl,
    error: row.error,
    outcome: row.outcome,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    sdkSessionId: row.sdkSessionId,
    budgetMaxTurns: row.budgetMaxTurns,
    budgetMaxUsd: row.budgetMaxUsd,
    budgetMaxSeconds: row.budgetMaxSeconds,
    userId: row.userId,
    title: row.title,
    personaId: row.personaId,
    legacyChatId: row.legacyChatId,
    planningStage: row.planningStage ?? null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    pendingSince: row.pendingSince ?? null,
    claimedAt: row.claimedAt ?? null,
    workerScope: row.workerScope ?? null,
    cancelRequested: row.cancelRequested ?? null,
    attempt: row.attempt ?? 1,
    result: row.result ?? null,
    parkReason: row.parkReason ?? null,
    pendingReason: row.pendingReason ?? null,
  };
}

export function hydrateMessage(row: typeof agentMessages.$inferSelect): MessageRow {
  let content: SdkContentBlock[] = [];
  try {
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed)) content = parsed as SdkContentBlock[];
  } catch {
    content = [{ type: "text", text: row.content }];
  }
  const role = (row.role as MessageRow["role"]) ?? "system";
  return { id: row.id, runId: row.runId, role, content: stripPiMessage(content), createdAt: row.createdAt };
}

function stripPiMessage(content: SdkContentBlock[]): SdkContentBlock[] {
  return content.map(({ piMessage: _piMessage, ...block }) => block);
}

/** Bridge to AgentSessionFull for legacy consumers (lib/agent.ts shim). */
export function toAgentSessionFull(row: RunRow): AgentSessionFull {
  if (row.taskId == null) {
    throw new Error(
      `toAgentSessionFull called on run #${row.id} with no task_id (use runs.get directly).`
    );
  }
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status,
    model: row.model,
    backend: row.backend,
    branch: row.branch,
    worktreePath: row.worktreePath,
    prUrl: row.prUrl,
    error: row.error,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    sdkSessionId: row.sdkSessionId,
    resumeOf: row.parentRunId,
    repoId: row.repoId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

// ──────────────────────────────────────────────────────────
// /runs UI read path: unified lister + legacy chat id resolver
// ──────────────────────────────────────────────────────────
//
// Since migration 0009, both task-derived agent sessions and chat
// conversations live in agent_runs. This block is the read path for the
// /runs UI — it returns every row regardless of origin, plus a helper
// to resolve a legacy chat id (the old chats.id) to the new run id for
// /chat/[id] redirects.

export interface RunFilters {
  repoId?: string;
  taskId?: string;
  planId?: string;
  /** Cap the number of rows returned (most-recent-first). */
  limit?: number;
}

/** /runs UI lister — a thin, narrower-typed wrapper over list(). */
export async function listRuns(filters: RunFilters = {}): Promise<RunRow[]> {
  return await list(filters);
}

/** Lean projection of a task-derived run — just what the Pi floor and plans
 *  index render. */
export interface TaskRunSummary {
  id: number;
  taskId: string;
  status: SessionStatus;
  prUrl: string | null;
  error: string | null;
  branch: string | null;
  title: string | null;
  personaId: string | null;
  totalCostUsd: number | null;
  budgetMaxUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

/**
 * Task-derived runs only (taskId set — the SQL form of origin === 'task'),
 * selecting only the columns above. list() drags every column of every run
 * along, including wide ones like worker_log and result, which dominate
 * transfer time on the floor/plans read path once run history grows.
 */
export async function listTaskRunSummaries(): Promise<TaskRunSummary[]> {
  const rows = await db
    .select({
      id: agentSessions.id,
      taskId: agentSessions.taskId,
      status: agentSessions.status,
      prUrl: agentSessions.prUrl,
      error: agentSessions.error,
      branch: agentSessions.branch,
      title: agentSessions.title,
      personaId: agentSessions.personaId,
      totalCostUsd: agentSessions.totalCostUsd,
      budgetMaxUsd: agentSessions.budgetMaxUsd,
      inputTokens: agentSessions.inputTokens,
      outputTokens: agentSessions.outputTokens,
      startedAt: agentSessions.startedAt,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(isNotNull(agentSessions.taskId))
    .orderBy(desc(agentSessions.startedAt));
  return rows.map((r) => ({ ...r, taskId: r.taskId!, status: r.status as SessionStatus }));
}

// Lookup any run by id, regardless of whether it's task-derived or
// chat-derived. lib/agent.getSession() filters to task-derived only and
// lib/chat.getChat() filters to chat-derived only; this is the un-filtered
// view for the /runs/[id] dispatcher.
export async function getRun(id: number): Promise<RunRow | null> {
  return await get(id);
}

// Resolve a legacy chats.id (from before migration 0009) to the new
// agent_runs.id, for /chat/[id] → /runs/[id] redirects.
export async function resolveLegacyChatId(chatId: number): Promise<number | null> {
  const row = (await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.legacyChatId, chatId), isNotNull(agentSessions.legacyChatId))))[0];
  return row?.id ?? null;
}

// Group key for the /runs UI. Order of buckets is: Active (live work),
// Idle (chat runs and queued task runs waiting on a worker), Closed.
// Lives in lib/run-index.ts (client-safe, no db imports) so the unified
// /runs index component can share it; re-exported here for server callers.
export { groupForStatus, RUN_GROUPS, RUN_GROUP_LABEL } from "./run-index";
export type { RunGroup } from "./run-index";

// ──────────────────────────────────────────────────────────
// Misc helpers
// ──────────────────────────────────────────────────────────

function authorFor(run: RunRow): string {
  if (run.goal === "<chat>") return "chat";
  return "claude-agent";
}

/** Union a comma-separated profile string with extra profile keys, preserving order. */
function mergeProfiles(base: string, add: string[]): string {
  const set = new Set(
    base
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  for (const a of add) {
    const t = a.trim();
    if (t) set.add(t);
  }
  return [...set].join(",");
}

function sandboxDbPathFor(run: RunRow, cwd: string): string {
  // Implement-style runs put the sandbox DB in the worktree (vanishes with
  // cleanup); chat-style runs share a per-run file in tmpdir so script state
  // built up earlier in the conversation persists across resumes.
  if (isImplementWorktree(run)) {
    return resolve(cwd, ".task-orch-sandbox.db");
  }
  return join(tmpdir(), `task-orch-run-${run.id}.sandbox.db`);
}

function sh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(args[0], args.slice(1), { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP(stdout);
      else rejectP(new Error(`${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
  });
}

function cleanupWorktree(path: string, root: string): Promise<void> {
  if (KEEP_WORKTREES) return Promise.resolve();
  if (!path || !existsSync(path)) return Promise.resolve();
  return new Promise((res) => {
    const child = spawn("git", ["worktree", "remove", "--force", path], { cwd: root });
    child.on("close", () => res());
    child.on("error", () => res());
  });
}
