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
//      idle, resumes the SDK session with that message as the prompt.
//      Concurrent appends on the same run are serialised by an in-process
//      lock so the SDK session never races against itself.
//   3. On stream end the run lands at `idle` (chat-style) or `completed`
//      (implement-style after PR). Errors → `failed`. Budget caps hit →
//      `budget_exhausted`. User cancellation → `cancelled`.
//   4. Worktree re-materialization: when resuming a worktree run whose
//      .worktrees/<id> directory has been pruned (server restart, manual
//      cleanup), runs.append() runs `git worktree add <path> <branch>` to
//      restore it before invoking the SDK.

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/db";
import { agentEvents, agentMessages, agentSessions } from "@/db/schema";
import { describe } from "@/lib/utils";
import * as repo from "./repo";
import {
  buildExecutePrompt,
  buildImplementPrompt,
  extractReviewOutcome,
  parseReviewVerdict,
} from "./run-templates";
import { parsePrUrl, ownerRepoFromRemote } from "./gh-url";
import { assistantText, toolResults, type SdkContentBlock } from "./sdk-message";
import type { AgentSessionFull, RepositoryRow, SessionStatus } from "./types";
import { isTerminalStatus, SESSION_STATUSES } from "./types";
import { resolveProfiles, alwaysOnExtensions, type ProfileContext } from "./profiles";
import { type RunEnvelope } from "./pi-event-mapper";
import { getBackend, type Extension } from "./agent-backend";
import {
  claimInboxEvents,
  emitInboxEvent,
  markControlInjected,
  quarantineEvent,
  setClaimTurn,
  toEnvelope,
  type EventEnvelope,
} from "./inbox";
import { sandboxFactory } from "./extensions/sandbox";
import { personaPromptFactory } from "./extensions/persona-prompt";
import { personaMemoryFactory } from "./extensions/persona-memory";
import { abortBridgeFactory } from "./extensions/abort-bridge";
import { linkSharedWorktreeArtifacts } from "./worktree-env";
// Namespace import (not `await import`) because reconcileOrphanedRuns() is
// synchronous, and calling through the namespace (runDispatch.dispatchRun) keeps
// vi.spyOn(dispatch, "dispatchRun") observable for the reconcile/routing tests.
// run-dispatch does NOT import from this module; instead we inject get()/
// isLeaseLive() into it below. That keeps the only static edge runs → run-dispatch
// (no cycle), avoiding the webpack-minified boot TDZ a runs ↔ run-dispatch cycle
// would otherwise produce.
import * as runDispatch from "./run-dispatch";

// Inject this module's helpers into run-dispatch (see the comment above). `get`,
// `isLeaseLive`, and `setError` are hoisted function declarations, so they are
// safe to reference at module-init time. `failRun` lets a failed worker spawn
// mark the run failed (status + event) instead of wedging it in 'preparing'.
runDispatch.__setRunsApi({
  get,
  isLeaseLive,
  failRun: setError,
  countInFlightWorkers,
  listPendingRunIds,
  reconcileOrphanedRuns,
  listLeasedRuns,
  handleWorkerDeath,
  checkTreeLimits,
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "anthropic/claude-sonnet-4-6";
const KEEP_WORKTREES = !!process.env.TASK_ORCH_KEEP_WORKTREES;

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
  model: string | null;
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
  /** Liveness lease; bumped while a turn runs. Null/stale in an active status = orphan. */
  heartbeatAt: Date | null;
  /** Detached worker (0020): the transient systemd-run scope owning this run, or null. */
  workerScope: string | null;
  /** Detached worker (0020): pid of the child worker process, or null. */
  workerPid: number | null;
  /** Detached worker (0020): 1 = cross-process cancel requested; the worker aborts at the next poll. */
  cancelRequested: number | null;
  /** Event system (§4.3): rework generation; bumped when a terminal-but-resumable run starts a new turn. */
  attempt: number;
  /** Event system (§4): structured result written by report_result/raise THIS turn, or null. */
  result: unknown | null;
  /** Event system (§6.1): why a 'parked' run is parked ('waiting'|'sleeping'|'question'), or null. */
  parkReason: string | null;
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
}

export interface AppendStreamEvent {
  type: "user_message" | "sdk" | "done" | "error";
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
}

const runners: Map<number, RunnerState> = globalThis.__runRunners ?? new Map();
if (!globalThis.__runRunners) globalThis.__runRunners = runners;

const locks: Map<number, PerRunLock> = globalThis.__runLocks ?? new Map();
if (!globalThis.__runLocks) globalThis.__runLocks = locks;

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
      ? "orchestrator,gh_pr,repo_read,spawn"
      : "orchestrator,repo_write");
  const initialStatus: SessionStatus =
    input.defer || goal === "<chat>" || goal === "<plan>" ? "idle" : "pending";

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

  // Resolve the effective model. The model is a per-run choice (the run-agent
  // dialog / chat composers emit a provider-qualified "provider/id"); it is no
  // longer tied to the persona. Fall back to the env default when the caller
  // omits one. We persist the resolved value so the UI shows what was used.
  const personaId = input.personaId ?? "implementor";
  if (!(await repo.getPersona(personaId))) {
    // persona_id is a foreign key; surface a clear 404 instead of letting the
    // insert fail with an opaque "FOREIGN KEY constraint failed".
    throw new repo.RepoError(`Persona '${personaId}' not found`, 404);
  }
  const effectiveModel = input.model ?? DEFAULT_MODEL;

  // Tree limits (Decision 2): reject BEFORE inserting, same reasoning as the
  // worktree-invariant checks above — validating after the insert would leave an
  // undriveable ghost row behind. Only applies to child runs; a root run (no
  // parentRunId) has no tree to bound.
  if (input.parentRunId != null) {
    const violation = await evaluateTreeLimits(input.parentRunId, { extraTreeRuns: 1 });
    if (violation) throw new repo.RepoError(violation, 400);
  }

  const inserted = await db
    .insert(agentSessions)
    .values({
      goal,
      taskId: input.taskId ?? null,
      planId: input.planId ?? null,
      repoId,
      parentRunId: input.parentRunId ?? null,
      toolsProfile,
      cwdStrategy,
      model: effectiveModel,
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
    })
    .returning();
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
    })();
  }

  // Review-style runs: spin up a worktree at the PR's head ref and run a
  // single agent turn against it. Requires a prUrl on the run (validated above).
  if (!input.defer && cwdStrategy === "worktree_at_pr") {
    void (async () => {
      const { detachedRunsEnabled } = await import("./run-dispatch");
      // FIX 7 (M20): launchDetached persists a custom initialPrompt as the first
      // user message so driveDispatchedRun's <review> branch can read it back and
      // pass it to runReview (which would otherwise be dispatched with no prompt).
      if (detachedRunsEnabled()) {
        await launchDetached(run.id, input.initialPrompt, input.parentRunId ?? null);
      } else await runReview(run.id, input.prUrl!, input.initialPrompt ?? null);
    })();
  }

  // Plan-executor runs: a single long-running agent that drives a whole plan
  // (implement → review → merge) by spawning child runs. Operates at the repo
  // root (no worktree of its own); children make their own worktrees.
  if (!input.defer && goal === "<execute>" && input.planId) {
    void (async () => {
      const { detachedRunsEnabled } = await import("./run-dispatch");
      // FIX 7 (M20): launchDetached persists a custom initialPrompt as the first
      // user message so driveDispatchedRun's <execute> branch can read it back and
      // pass it to runExecute as operator instructions.
      if (detachedRunsEnabled()) {
        await launchDetached(run.id, input.initialPrompt, input.parentRunId ?? null);
      } else await runExecute(run.id, input.planId!, input.initialPrompt ?? null);
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
  const q = db.select().from(agentSessions).orderBy(desc(agentSessions.startedAt));
  const rows = where ? await q.where(where) : await q;
  return rows.map(hydrateRun);
}

const TERMINAL_STATUS_LIST: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

export async function get(id: number): Promise<RunRow | null> {
  const row = (await db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0];
  return row ? hydrateRun(row) : null;
}

export async function listMessages(runId: number): Promise<MessageRow[]> {
  return (
    await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(asc(agentMessages.id))
  ).map(hydrateMessage);
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
    if (runners.has(input.runId) || (isLeaseLive(run) && !adoptingOwnClaim)) {
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
    // branch. Only `closed` is a hard stop. Chat/none runs keep idle-only resume.
    if (
      isTerminalStatus(run.status) &&
      run.status !== "idle" &&
      !isResumableWorktreeRun(run.status, run.cwdStrategy)
    ) {
      const why =
        run.status === "closed"
          ? "is closed; fork it to continue"
          : `is in terminal status '${run.status}'; cannot resume`;
      yield { type: "error", error: `Run ${input.runId} ${why}.` };
      return;
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
    const resumesTerminalAttempt =
      isTerminalStatus(run.status) && isResumableWorktreeRun(run.status, run.cwdStrategy);
    await db.update(agentSessions)
      .set({
        result: null,
        parkReason: null,
        ...(resumesTerminalAttempt ? { attempt: sql`${agentSessions.attempt} + 1` } : {}),
      })
      .where(eq(agentSessions.id, run.id));

    await setStatus(run.id, "running");

    // Register the abort handle and bus BEFORE the (seconds-long) worktree prep.
    // If we waited until after prepareCwd (the old behaviour), a cancel()/
    // interrupt()/close() landing during `git worktree add` would find no runner
    // and fail to abort — the turn would then run to completion and its final
    // update would resurrect a row the user already cancelled.
    const author = input.author ?? authorFor(run);
    const abort = input.abort ?? new AbortController();
    const bus = new EventEmitter();
    runners.set(run.id, { abort, bus });
    ownsRunner = true;

    // Open the liveness lease and keep it fresh for the whole active period
    // (prepare → turn → push/PR). The interval ticks even while a slow model or
    // tool call is awaited, so a long-but-alive turn is never mistaken for an
    // orphan. It also polls the cross-process cancel flag so a detached worker
    // aborts when cancel() flips cancel_requested. Cleared in the finally below.
    heartbeat = startHeartbeatWithCancel(input.runId, abort);

    // First turn of a worktree run: create its branch + worktree. On later
    // turns this is a no-op and prepareCwd re-materializes a missing worktree
    // (server restarts / `git worktree prune` kill the directory; the branch
    // survives, so we recreate it).
    let cwd: string;
    try {
      run = await ensureWorktreeBranch(run, input.baseBranch);
      cwd = await prepareCwd(run);
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
      const digest = await injectPendingInboxEvents(run.id);
      if (digest) effectivePrompt = `${digest}\n\n${input.text}`;
    } catch {
      // pump sweep / next turn retries pending events
    }

    let result: TurnResult;
    try {
      result = await runOneTurn({
        run,
        cwd,
        prompt: effectivePrompt,
        abort,
        author,
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
      yield { type: "sdk", sdk: env };
    }

    // Worktree runs sync git after each turn: if the branch gained commits,
    // push them (updating the PR) and open a PR the first time round. A no-op
    // for chat-only turns (no commits) and for non-worktree runs.
    let prUrlUpdate = run.prUrl;
    if (isImplementWorktree(run)) {
      try {
        prUrlUpdate = await gitSyncAfterTurn(run, cwd, result.summary, input.baseBranch);
      } catch (err) {
        await persistMessage(run.id, "system", [
          { type: "text", text: `Push/PR sync failed: ${describe(err)}` },
        ]);
      }
    }

    // Worktree runs (the task's attached session) land at `completed` after each
    // turn — terminal so the executor's await_session resolves, but resumable
    // via the guard above. Chat/none runs land `idle`. Budget caps win.
    // Turn-end parking contract (§6.1): tools may have written park_reason
    // (timer__sleep / ask_parent) or result (report_result / raise) mid-turn —
    // re-read both FRESHLY from the DB and let them steer the landing status
    // via decideTurnEndStatus (result > budget > park > default).
    const budgetHit = checkBudget(run, result);
    const landsCompleted = isImplementWorktree(run);
    const turnEnd = await readTurnEndState(run.id);
    const nextStatus: SessionStatus = decideTurnEndStatus({
      goal: run.goal,
      freshStatus: turnEnd.status,
      parkReason: turnEnd.parkReason,
      result: turnEnd.result,
      budgetHit,
      defaultStatus: landsCompleted ? "completed" : "idle",
    });
    // Review-style runs surface a structured verdict in `outcome`. Gated on
    // goal so chat/implement append flows are unaffected.
    const outcomeUpdate =
      run.goal === "<review>"
        ? extractReviewOutcome(result.summary) ?? run.outcome
        : run.outcome;
    // Conditional on the row NOT already being terminal-by-user: a cancel()/
    // close() that raced in right as the turn ended must win. Without the WHERE
    // guard this update would resurrect a 'cancelled'/'closed' run.
    const finalUpdate = await db.update(agentSessions)
      .set({
        status: nextStatus,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
        outcome: outcomeUpdate,
        prUrl: prUrlUpdate,
        // Keep park_reason only when actually parking; clear a stale one that
        // lost to a result/budget landing. Parked is non-terminal: no completedAt.
        parkReason: nextStatus === "parked" ? turnEnd.parkReason : null,
        completedAt: isTerminalStatus(nextStatus) ? new Date() : null,
      })
      .where(
        and(
          eq(agentSessions.id, run.id),
          notInArray(agentSessions.status, ["cancelled", "closed"])
        )
      );
    // Tell live SSE subscribers (the run-view in the browser) that the turn
    // ended — emit BEFORE dropping the runner (in the finally) so the bus still
    // exists. Only emit when we actually wrote the row; if a cancel()/close()
    // won the race the update was a no-op and the aborter already emitted.
    if (finalUpdate.count > 0) {
      await emitStatus(run.id, nextStatus);
      // Child lifecycle producer (§3.1): a terminal landing on a child run
      // becomes a durable inbox event for its parent. Best-effort by design.
      if (isTerminalStatus(nextStatus)) void emitTerminalChildEvent(run.id);
    }

    yield { type: "done" };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Drop the in-process runner on every exit path (success, error, abort) —
    // but only if THIS append created it. Leaving it set would make the guard
    // above reject the next message with a false "already in flight".
    if (ownsRunner) runners.delete(input.runId);
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
  await db.update(agentSessions)
    .set({ status: "cancelled", completedAt: new Date(), cancelRequested: 1 })
    .where(eq(agentSessions.id, id));
  await emitStatus(id, "cancelled");
  // Event system (§6.6): mirror the cancel as a CONTROL-class inbox row — the
  // model can never claim/swallow it; enforcement stays platform-side (the
  // heartbeat poll aborts and then markControlInjected acknowledges the row).
  // Plus the per-run-singleton terminal event for the parent (§3.1).
  void emitInboxEvent({
    targetRunId: id,
    type: "run.cancel_requested",
    sourceKind: "system",
    sourceId: String(id),
    dedupeKey: `cancel:${id}`,
    payload: { run_id: id },
    noWake: true,
  }).catch(() => {});
  void emitTerminalChildEvent(id);
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
  await db.update(agentSessions)
    .set({ status: "idle", completedAt: null })
    .where(eq(agentSessions.id, id));
  await emitStatus(id, "idle");
  return true;
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
  await db.update(agentSessions)
    .set({ status: "closed", completedAt: new Date(), cancelRequested: 1 })
    .where(eq(agentSessions.id, id));
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
 * Resume a completed/idle worktree run for an unattended follow-up turn —
 * e.g. the GitHub webhook handler reacting to a CI failure on the run's PR.
 *
 * Re-materializes the worktree on the run's branch, runs one agent turn with
 * the given prompt, then pushes the branch (to update the PR and re-trigger
 * CI) and returns the run to `completed`. A fresh SDK session is started
 * rather than resuming `sdkSessionId`, because the original session files live
 * inside the (since-cleaned-up) worktree; the prompt + the checked-out code +
 * the gh tools give the agent everything it needs.
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
  if (isLeaseLive(run) || isWorkerLive(run)) return;
  if (run.cwdStrategy !== "worktree" || !run.branch || !run.worktreePath) return;

  const lock = getLock(runId);
  while (lock.busy) {
    try {
      await lock.busy;
    } catch {
      // prior turn errored; take the slot anyway
    }
  }
  // Re-check liveness after acquiring the slot (another follow-up may have run
  // while we waited). Re-read the row: a detached worker may have claimed/started
  // a turn cross-process while we were queued, which only a FRESH read reveals.
  if (isLive(runId)) return;
  const fresh = await get(runId);
  if (!fresh || isLeaseLive(fresh) || isWorkerLive(fresh)) return;
  let release!: () => void;
  lock.busy = new Promise<void>((res) => (release = res));

  const abort = new AbortController();
  const bus = new EventEmitter();
  runners.set(runId, { abort, bus });
  // Keep the liveness lease fresh so this webhook-driven follow-up turn isn't
  // treated as an orphan by append()/reconcileOrphanedRuns() mid-turn.
  const heartbeat = startHeartbeat(runId);

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

    await db.update(agentSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId));
    await emitStatus(runId, "completed");
    void emitTerminalChildEvent(runId);
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
 * field of the resolved repo they read.
 */
async function resolveRepo(run: { repoId: string | null; taskId: string | null }): Promise<RepositoryRow | null> {
  if (run.repoId) {
    const r = await repo.getRepository(run.repoId);
    if (r) return r;
  }
  if (run.taskId) {
    const r = await repo.resolveRepoForTask(run.taskId);
    if (r) return r;
  }
  return await repo.defaultRepo();
}

async function repoRoot(run: { repoId: string | null; taskId: string | null }): Promise<string> {
  const r = await resolveRepo(run);
  return r?.localPath ? resolve(r.localPath) : ORCHESTRATOR_ROOT;
}

/**
 * Guard the resolved working directory before it reaches the agent backend.
 * A missing cwd makes `child_process.spawn` emit `ENOENT` *against the
 * executable*, which the Claude Agent SDK then misreports as a native-binary /
 * libc mismatch ("binary exists but failed to launch"). Validate here so a
 * stale repository `local_path` surfaces as an actionable error naming the
 * offending repo instead of a misleading message about the Claude binary.
 */
export function validateCwd(dir: string, ctx: { runId: number; repoId: string | null }): string {
  const where = `repository '${ctx.repoId ?? "(default)"}'`;
  if (!existsSync(dir)) {
    throw new Error(
      `Run #${ctx.runId}: working directory '${dir}' does not exist. ` +
        `Check the local_path of ${where}.`
    );
  }
  if (!statSync(dir).isDirectory()) {
    throw new Error(
      `Run #${ctx.runId}: working directory '${dir}' is not a directory. ` +
        `Check the local_path of ${where}.`
    );
  }
  return dir;
}

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
      await db.update(agentSessions)
        .set({ worktreePath: sessionWork })
        .where(eq(agentSessions.id, run.id));
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
    await sh(["git", "worktree", "add", run.worktreePath, run.branch], root);
    await linkSharedWorktreeArtifacts(run.worktreePath, root);
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
  return (
    status === "idle" ||
    status === "completed" ||
    status === "failed" ||
    status === "budget_exhausted"
  );
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
 * Branch name for a worktree run. Task-attached (implement) runs use the task id
 * so the branch reads as `claude/<task>-<run>`; taskless chat worktrees fall back
 * to `claude/chat-<run>`.
 */
export function worktreeBranchName(run: { id: number; taskId: string | null }): string {
  const scope = run.taskId ? run.taskId.toLowerCase() : "chat";
  return `claude/${scope}-${run.id}`;
}

/** The base branch a task's worktree branches from / merges in. */
async function repoDefaultBranch(run: { repoId: string | null; taskId: string | null }): Promise<string> {
  return (await resolveRepo(run))?.defaultBranch ?? "main";
}

/**
 * First turn of a worktree run: create its branch (`claude/<task>-<run>`) and
 * worktree off the base branch, persist them, and move the task to in_progress.
 * No-op once a branch exists (later turns re-materialize via prepareCwd).
 */
function sessionRepoPath(): string | null {
  const root = process.env.SESSION_ROOT;
  return root ? resolve(root, "repo") : null;
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
  if (!existsSync(join(work, ".git"))) {
    const reference = mirror && existsSync(mirror) ? ["--reference", mirror, "--dissociate"] : [];
    // Blobless partial clone: history blobs are fetched on demand through the
    // image's git credential helper; pairs with the image-baked blobless mirror
    // so a cold clone moves only refs/commits/trees plus the checkout's blobs.
    await sh(["git", "clone", "--filter=blob:none", ...reference, url, work], "/");
  } else {
    await sh(["git", "-C", work, "remote", "set-url", "origin", url], "/").catch(() => {});
  }
  await sh(["git", "-C", work, "fetch", "--prune", "origin"], "/").catch(() => {});
  if (base) {
    await sh(["git", "-C", work, "checkout", "-B", branch, `origin/${base}`], "/");
  } else {
    try {
      await sh(["git", "-C", work, "fetch", "origin", branch], "/");
      await sh(["git", "-C", work, "checkout", "-B", branch, `origin/${branch}`], "/");
    } catch {
      const def = await repoDefaultBranch(run);
      await sh(["git", "-C", work, "checkout", "-B", branch, `origin/${def}`], "/");
    }
  }
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
  if (!existsSync(join(work, ".git"))) {
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
  const base = baseBranch?.trim() || (await repoDefaultBranch(run));
  const branch = worktreeBranchName(run);
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
    const root = await repoRoot(run);
    const worktreeRoot = resolve(root, ".worktrees");
    worktreePath = resolve(worktreeRoot, String(run.id));
    await mkdir(worktreeRoot, { recursive: true });
    await sh(["git", "worktree", "add", "-b", branch, worktreePath, base], root);
    await linkSharedWorktreeArtifacts(worktreePath, root);
  }
  const taskRepoId = run.taskId ? (await repo.getTask(run.taskId))?.repoId ?? null : null;
  await db.update(agentSessions)
    .set({ branch, worktreePath, repoId: run.repoId ?? taskRepoId })
    .where(eq(agentSessions.id, run.id));
  // Task-attached (implement) runs move their task to in_progress; taskless chat
  // worktrees have nothing to transition.
  const task = run.taskId ? await repo.getTask(run.taskId) : null;
  if (run.taskId && task && (task.state === "todo" || task.state === "blocked")) {
    try {
      await repo.transitionTask(run.taskId, {
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
 * After a worktree turn: if the branch gained commits ahead of its base, push
 * them. The first time (no PR yet) open one and move the task to review;
 * afterwards the push just updates the existing PR. Returns the (possibly new)
 * PR url. A no-op when the turn produced no commits (pure conversation).
 */
async function gitSyncAfterTurn(
  run: RunRow,
  cwd: string,
  summary: string | null,
  baseBranch?: string
): Promise<string | null> {
  if (!run.branch) return run.prUrl;
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
  const task = await repo.getTask(run.taskId);
  if (!task) return null;
  const prUrl = await openPr({ task, branch: run.branch, baseBranch: base, worktreePath: cwd, summary });
  if (prUrl) {
    try {
      await repo.transitionTask(run.taskId, {
        state: "review",
        note: `Agent finished. PR: ${prUrl}`,
      });
    } catch (err) {
      await repo.addNote(run.taskId, "claude-agent", `Could not transition to review: ${describe(err)}`);
    }
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
  runners.set(runId, { abort, bus });
  // Keep the liveness lease fresh for the whole worker (prepare → turn), so an
  // append()/reconcileOrphanedRuns() can't mistake this live review for an
  // orphan and take it over / mark it failed mid-turn. The same interval polls
  // the cross-process cancel flag so a detached review aborts on cancel().
  const heartbeat = startHeartbeatWithCancel(runId, abort);

  let run = (await get(runId))!;
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

    await db.update(agentSessions)
      .set({ branch, worktreePath })
      .where(eq(agentSessions.id, runId));
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

    await db.update(agentSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        outcome,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId));
    await emitStatus(runId, "completed");
    void emitTerminalChildEvent(runId);

    // An approving verdict marks the task done. The outcome is the JSON
    // verdict block extracted above (or a fallback first line, which won't
    // parse — so a non-approve outcome simply leaves the task untouched).
    if (run.taskId && parseReviewVerdict(outcome) === "approve") {
      try {
        await repo.transitionTask(run.taskId, {
          state: "done",
          note: `Review run #${runId} approved the PR.`,
        });
      } catch (err) {
        await repo.addNote(
          run.taskId,
          "claude-reviewer",
          `Review approved but could not transition task to done: ${describe(err)}`
        );
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    await setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
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
  runners.set(runId, { abort, bus });
  // Keep the liveness lease fresh for the whole (long-running) executor turn so
  // append()/reconcileOrphanedRuns() never treat this live run as an orphan. The
  // same interval polls the cross-process cancel flag so a detached executor
  // aborts on cancel().
  const heartbeat = startHeartbeatWithCancel(runId, abort);

  let run = (await get(runId))!;

  try {
    const plan = await repo.getPlan(planId);
    if (!plan) {
      await setError(runId, `Plan ${planId} disappeared before execution could start`);
      runners.delete(runId);
      return;
    }

    await setStatus(runId, "running");
    // Event system (§6.1): fresh turn = fresh intent — clear last turn's
    // park_reason and result before this turn runs (this is how a parked
    // executor woken by the pump sweep starts clean).
    await db.update(agentSessions)
      .set({ parkReason: null, result: null })
      .where(eq(agentSessions.id, runId));
    // No worktree of its own — operate at the repo root so gh_pr tools shell
    // out against the real checkout. Children create their own worktrees.
    const cwd = await prepareCwd(run);
    // The execute scaffold (orchestration loop + task list) always runs; an
    // operator-supplied prompt is appended as steering guidance rather than
    // replacing it, so the executor never loses its core instructions.
    const base = buildExecutePrompt(plan, await repo.listTasks({ planId }));
    const extra = initialPrompt?.trim();
    let prompt = extra ? `${base}\n\n## Operator instructions\n\n${extra}` : base;
    // Digest injection (§6.4): a (re)dispatched executor consumes its pending
    // inbox events at turn start — the digest frame is persisted and the same
    // data rides the prompt. Best-effort: never block the turn on the inbox.
    try {
      const digest = await injectPendingInboxEvents(runId);
      if (digest) prompt = `${prompt}\n\n${digest}`;
    } catch {
      // pump sweep / next turn retries pending events
    }
    // Persist the kickoff prompt so a page load shows what this executor was
    // asked to do — the executor is driven server-side, so unlike append()
    // there is no user message row anchoring the transcript.
    await persistMessage(runId, "system", [{ type: "text", text: prompt }]);
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
    await db.update(agentSessions)
      .set({
        status: endStatus,
        parkReason: endStatus === "parked" ? turnEnd.parkReason : null,
        completedAt: isTerminalStatus(endStatus) ? new Date() : null,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId));
    await emitStatus(runId, endStatus);
    if (isTerminalStatus(endStatus)) void emitTerminalChildEvent(runId);

    // Fallback: if the agent drove every task to a terminal state but didn't
    // close the plan itself, mark the plan done. (Skipped when the executor
    // parked — it is still mid-plan by its own account.)
    try {
      if (endStatus === "completed") {
        const tasks = await repo.listTasks({ planId });
        const allClosed =
          tasks.length > 0 &&
          tasks.every((t) => t.state === "done" || t.state === "cancelled");
        const planNow = await repo.getPlan(planId);
        if (allClosed && planNow && planNow.state === "accepted") {
          await repo.updatePlan(planId, { state: "done" });
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
    await setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
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
export async function driveDispatchedRun(runId: number): Promise<void> {
  const run = await get(runId);
  if (!run) return;

  // Chat runs get a long-lived, warm-checkout session loop — one turn per inbound
  // user message (run_input channel) — instead of a single turn-and-exit. Returns
  // only when the chat idles out; the worker then exits. driveChatSession manages
  // (and releases) its own claim in its finally, so it returns BEFORE the
  // single-turn release below and must not be routed through it.
  if (run.goal === "<chat>") {
    await driveChatSession(runId);
    return;
  }

  // Single-turn detached workers (review / execute / implement) drive ONE turn and
  // exit. Their final DB update lands a terminal status but never clears the worker
  // claim (worker_scope/worker_pid) — and handleWorkerDeath early-returns on a
  // terminal status before it would release. A lingering claim then wedges the run:
  // dispatchRun forever returns "already-claimed" (a follow-up via sendMessageToRun
  // persists but spawns nothing), and countInFlightWorkers charges the ghost claim
  // against the admission budget until the heartbeat goes stale (HEARTBEAT_STALE_MS,
  // 5 min). Release the claim here — this runs inside the worker process that owns
  // it, so it is the single safe release point covering every single-turn path
  // (including the setError early-exits, which are inside the try). Unconditional,
  // mirroring driveChatSession's finally: the row is terminal, so no concurrent
  // re-dispatch can have re-claimed it (dispatchRun no-ops while worker_scope is set).
  // FIX 3a (M7): snapshot the newest user message BEFORE driving the turn. A
  // follow-up user message persisted while this single-turn worker's turn is in
  // flight is rejected by dispatchRun ("already-claimed"); once we exit nothing
  // re-dispatches it and it sits unprocessed forever. In the finally (after the
  // claim release) we re-check and fire a fresh dispatch, mirroring
  // driveChatSession's stranded-message drain.
  const priorUserId = await newestUserMessageId(runId);
  try {
    if (run.goal === "<review>") {
      if (!run.prUrl) {
        await setError(runId, "Dispatched <review> run has no prUrl to review.");
        return;
      }
      // FIX 7b (M20): a custom initialPrompt was persisted as the run's first user
      // message by create(); pass it into runReview so the review uses it instead
      // of the default prompt. runReview builds its own prompt and does NOT persist
      // it (unlike runExecute), so there is no duplicate message row.
      await runReview(runId, run.prUrl, await firstUserMessageText(runId));
      return;
    }

    if (run.goal === "<execute>") {
      if (!run.planId) {
        await setError(runId, "Dispatched <execute> run has no planId to execute.");
        return;
      }
      // Operator instructions for this turn: the UNANSWERED user backlog first.
      // A follow-up message to a completed executor ("continue with merging")
      // re-dispatches it through here — feeding only the FIRST user message
      // would replay the original instructions and silently drop what the
      // operator just said. The backlog is exactly the not-yet-answered
      // messages; on a fresh executor it IS the first message (the custom
      // initialPrompt create() persisted, FIX 7b/M20), and on an orphan
      // re-dispatch with nothing new it's empty → fall back to that first
      // message, preserving the old behavior. runExecute persists its own
      // SYSTEM scaffold prompt — a different role than our user rows — so
      // nothing duplicates.
      await runExecute(
        runId,
        run.planId,
        unansweredUserBacklogText(await listMessages(runId)) ?? (await firstUserMessageText(runId))
      );
      return;
    }

    // implement (or a resumed run): drive ONE turn and exit. A fresh implement run
    // reconstructs the task prompt create() would have passed to kickoffFirstTurn; a
    // resume (orphan re-dispatch) or a follow-up message replays its last user
    // message, falling back to a bare continue sentinel.
    // takeover: this worker holds the run's claim (dispatchRun left it `preparing`
    // with a fresh heartbeat), so append() must adopt it rather than reject it as
    // an in-flight turn in another process.
    // fromUserMsg tells us the prompt IS an already-persisted user message (a
    // follow-up the server inserted, or a replayed one) — so append must not
    // re-insert it (persistUser=false). A synthesized task prompt / resume sentinel
    // is persisted as the first user message (persistUser=true).
    const { text, fromUserMsg } = await dispatchTurnPrompt(run);
    await kickoffFirstTurn(runId, text, undefined, true, !fromUserMsg);
  } finally {
    // Release the single-turn worker claim now the turn has landed. Does NOT touch
    // heartbeatAt (the turn is over; staleness is fine). Guarded on the row NOT
    // being in a lease status: our own turn always lands a non-lease status before
    // this runs, so a lease status here can only mean a false death report released
    // our claim mid-turn and a re-dispatched worker re-claimed — clearing THAT
    // worker's healthy claim would strand it exactly the way this release exists
    // to prevent.
    await db
      .update(agentSessions)
      .set({ workerScope: null, workerPid: null })
      .where(
        and(
          eq(agentSessions.id, runId),
          notInArray(agentSessions.status, LEASE_STATUSES)
        )
      );
    // FIX 3a (M7): a newer non-empty user message arrived while this turn ran — it
    // was rejected as "already-claimed" and would otherwise never be processed.
    // Now the claim is released, fire-and-forget a fresh dispatch so a new worker
    // picks it up (mirrors driveChatSession's finally). Skipped when cancel/close
    // made the run terminal — those must not be revived.
    const cur = await get(runId);
    if (cur && cur.status !== "cancelled" && cur.status !== "closed") {
      const newer = (await listMessages(runId)).some(
        (m) => m.role === "user" && m.id > priorUserId && messageText(m) !== ""
      );
      if (newer) void runDispatch.dispatchRun(runId).catch(() => {});
    }
  }
}

const DISPATCH_RESUME_PROMPT =
  "Resume this run and continue from where the previous session left off.";

/** Extract the concatenated text of a message's content blocks. */
function messageText(m: MessageRow): string {
  return m.content
    .map((b) =>
      b.type === "text" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : ""
    )
    .join("")
    .trim();
}

/**
 * Concatenated text of the UNANSWERED user-message backlog — every user message
 * newer than the most recent 'agent'-role reply, joined with blank lines — or
 * null when everything has been answered. Pure over the rows so it's directly
 * unit-testable. Used by dispatchTurnPrompt (implement follow-ups) and by
 * driveDispatchedRun's <execute> branch (operator steering of a plan executor).
 */
export function unansweredUserBacklogText(msgs: MessageRow[]): string | null {
  let lastAgentId = 0;
  for (const m of msgs) if (m.role === "agent" && m.id > lastAgentId) lastAgentId = m.id;
  const backlog = msgs
    .filter((m) => m.role === "user" && m.id > lastAgentId)
    .map(messageText)
    .filter((t) => t !== "");
  return backlog.length > 0 ? backlog.join("\n\n") : null;
}

async function dispatchTurnPrompt(run: RunRow): Promise<{ text: string; fromUserMsg: boolean }> {
  // FIX 3b/FIX 7a: replay the UNANSWERED user-message backlog first — every
  // user message newer than the most recent 'agent'-role reply, concatenated
  // with blank lines. This covers, in one branch:
  //   • a resume / single follow-up after the agent last replied,
  //   • SEVERAL follow-ups that piled up while a single-turn worker was mid-turn
  //     (the old code replayed only the LAST, silently dropping the rest),
  //   • a custom initialPrompt that create()'s detached kickoff persisted as the
  //     run's first user message (FIX 7) — which must WIN over the synthesized
  //     task prompt, hence this check runs BEFORE buildImplementPrompt below.
  // These rows are already in the DB, so the caller must NOT re-persist them
  // (fromUserMsg=true → kickoffFirstTurn passes persistUser=false).
  const msgs = await listMessages(run.id);
  const backlogText = unansweredUserBacklogText(msgs);
  if (backlogText != null) return { text: backlogText, fromUserMsg: true };

  // First turn of a fresh implement worktree run with no persisted messages:
  // rebuild the task prompt (synthesized, not yet persisted → caller persists it).
  if (!run.sdkSessionId && run.taskId) {
    const task = await repo.getTask(run.taskId);
    if (task) return { text: await buildImplementPrompt(task), fromUserMsg: false };
  }
  // Resume with nothing new to say (orphan re-dispatch): a bare continue sentinel.
  return { text: DISPATCH_RESUME_PROMPT, fromUserMsg: false };
}

/** First non-empty user-message text of a run, or null. Used by driveDispatchedRun
 *  to feed a custom initialPrompt (persisted by create() under FIX 7) into
 *  runReview/runExecute, which build their own prompts and take it as an override. */
async function firstUserMessageText(runId: number): Promise<string | null> {
  const msgs = await listMessages(runId);
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const t = messageText(m);
    if (t) return t;
  }
  return null;
}

/** Newest user-message id of a run (0 if none). Snapshot before a single-turn
 *  drive so its finally can detect a follow-up that arrived mid-turn (FIX 3a). */
async function newestUserMessageId(runId: number): Promise<number> {
  const msgs = await listMessages(runId);
  let id = 0;
  for (const m of msgs) if (m.role === "user" && m.id > id) id = m.id;
  return id;
}

// ──────────────────────────────────────────────────────────
// Long-lived chat worker + server-side dispatch/relay
// ──────────────────────────────────────────────────────────

function chatIdleMs(): number {
  const raw = process.env.TASK_ORCH_CHAT_IDLE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600_000;
}

/** Per-turn end marker on the run_stream tail. Lets the server relay close a
 *  single turn's response while the chat run stays idle/resumable (the worker
 *  lives on). Rides the existing run_stream NOTIFY as a plain agent_events row. */
async function emitTurnDone(runId: number): Promise<void> {
  try {
    await db
      .insert(agentEvents)
      .values({ sessionId: runId, type: "turn_done", payload: "{}", createdAt: new Date() });
  } catch {
    // best-effort: a missed marker just falls back to the relay's safety timeout.
  }
}

/**
 * Long-lived chat worker loop — runs INSIDE a dispatched worker container for a
 * goal='<chat>' run. Keeps the checkout warm (/work/<id> reused across turns) and
 * runs one append() turn per inbound user message, learning of new messages via
 * the run_input LISTEN channel. Exits after TASK_ORCH_CHAT_IDLE_MS with no
 * message; the run lands 'idle' (resumable) and releases its claim, so the next
 * message re-dispatches a fresh worker that resumes via sdkSessionId.
 */
export async function driveChatSession(runId: number): Promise<void> {
  const { subscribeRunInput } = await import("./run-stream-listener");
  const idleMs = chatIdleMs();
  const abort = new AbortController();
  // Keep the heartbeat fresh even while idle-waiting (so reconcile can't reap a
  // parked worker) AND poll the cross-process cancel flag so a UI cancel aborts.
  const heartbeat = startHeartbeatWithCancel(runId, abort);

  // On (re)start, skip user messages a prior worker already handled — the resumed
  // SDK session already contains those turns. Each completed turn emits exactly one
  // turn_done and messages are drained in id order, so the turn_done count is the
  // number of already-processed user messages. (A fresh chat has 0 → start at 0.)
  const priorTurns = (
    await db
      .select({ id: agentEvents.id })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, "turn_done")))
  ).length;
  const priorUserIds = (await listMessages(runId))
    .filter((m) => m.role === "user")
    .map((m) => m.id)
    .sort((a, b) => a - b);
  let lastProcessed =
    priorTurns > 0 && priorTurns <= priorUserIds.length ? priorUserIds[priorTurns - 1] : 0;
  let pendingWake = false;
  let wake: (() => void) | null = null;
  const unsub = await subscribeRunInput(runId, () => {
    pendingWake = true;
    wake?.();
    wake = null;
  });
  const onAbort = () => {
    wake?.();
    wake = null;
  };
  abort.signal.addEventListener("abort", onAbort);

  try {
    for (;;) {
      // Drain all unprocessed user messages oldest-first, one turn each (handles
      // messages that arrived while the previous turn was running).
      const msgs = (await listMessages(runId)).filter(
        (m) => m.role === "user" && m.id > lastProcessed
      );
      for (const m of msgs) {
        if (abort.signal.aborted) return;
        const run = await get(runId);
        if (!run || run.status === "closed") return;
        lastProcessed = m.id;
        const text = messageText(m);
        if (!text) continue;
        // takeover only on the very first turn (run still 'preparing' from
        // dispatchRun's claim); later turns see 'idle'. persistUser=false: the
        // message is already in the DB — it's how we were woken.
        for await (const _ev of append({
          runId,
          role: "user",
          text,
          persistUser: false,
          takeover: run.status === "preparing",
          abort,
        })) {
          void _ev; // frames reach clients via the run_stream tail (server relay)
        }
        await emitTurnDone(runId);
      }
      if (abort.signal.aborted) break;
      // Idle-wait for the next run_input notify or the idle timeout.
      if (!pendingWake) {
        const timedOut = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => {
            wake = null;
            resolve(true);
          }, idleMs);
          wake = () => {
            clearTimeout(t);
            resolve(false);
          };
        });
        if (timedOut) {
          // A run_input notify can land in the race between the timeout firing
          // (which nulled `wake`) and here: its callback set pendingWake but had no
          // live `wake` to resume us. Don't strand that message — loop back to drain
          // it instead of exiting on the timeout.
          if (pendingWake) {
            pendingWake = false;
            continue;
          }
          break;
        }
      }
      pendingWake = false;
    }
  } finally {
    clearInterval(heartbeat);
    unsub();
    abort.signal.removeEventListener("abort", onAbort);
    // Release the claim so the next message spawns a fresh worker, and land the
    // run resumable-idle (unless cancel/close already wrote a terminal row).
    // Guarded on the row NOT being in a lease status, mirroring the single-turn
    // release in driveDispatchedRun: a lease status here means a false death
    // report already released our claim and a re-dispatched worker re-claimed —
    // don't clear the new owner's claim out from under it.
    await db
      .update(agentSessions)
      .set({ workerScope: null, workerPid: null })
      .where(
        and(
          eq(agentSessions.id, runId),
          notInArray(agentSessions.status, LEASE_STATUSES)
        )
      );
    const cur = await get(runId);
    if (cur && !isTerminalStatus(cur.status)) await setStatus(runId, "idle");
    // Final drain guard against a message stranded by the idle-timeout race: a
    // user message can be persisted (and its run_input NOTIFY fired) in the window
    // between our last drain and the claim release above. sendMessageToRun saw
    // isWorkerLive()===true then, so it only NOTIFYed and did NOT dispatch — and
    // with this worker now exiting, that message would sit unprocessed until some
    // FUTURE message triggered a dispatch. Re-check for any unprocessed user message
    // (id > lastProcessed, non-empty) now the claim is released and, if one exists,
    // fire-and-forget a fresh dispatch so a new worker resumes and drains it. Also
    // covers a run_input NOTIFY lost entirely. Skipped when cancel/close made the
    // run terminal — those must not be revived.
    if (cur && !isTerminalStatus(cur.status)) {
      const stranded = (await listMessages(runId)).some(
        (m) => m.role === "user" && m.id > lastProcessed && messageText(m) !== ""
      );
      if (stranded) void runDispatch.dispatchRun(runId).catch(() => {});
    }
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
  // Remote runner deployments (Docker worker image or Fly Machines provider)
  // force turns through workers. Plain dev/test with no remote runner keeps the
  // old in-process streaming path.
  if (!runDispatch.remoteRunnerEnabled()) {
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

  const fresh = await get(runId);
  if (fresh) {
    if (run.goal === "<chat>") {
      if (!isWorkerLive(fresh)) {
        // Clear a dead worker's stale claim so dispatchRun can re-claim (idle chat
        // rows aren't a lease status, so reconcile never cleared it).
        if (fresh.workerScope) {
          await db
            .update(agentSessions)
            .set({ workerScope: null, workerPid: null })
            .where(eq(agentSessions.id, runId));
        }
        await runDispatch.dispatchRun(runId);
      }
      // else: a live worker will pick up the run_input notify.
    } else {
      // Non-chat follow-up: dispatch a single-turn worker. If the prior turn is
      // still in flight the claim is held and dispatchRun returns already-claimed
      // (harmless — that turn will resume onto this freshly persisted message).
      // Once the prior turn finished it released its claim (see
      // driveDispatchedRun's finally), so this dispatch now spawns a fresh worker
      // to pick up the follow-up instead of no-oping against a ghost claim forever.
      await runDispatch.dispatchRun(runId);
    }
  }

  yield* relayRunStream(runId, from, abort, ownMsg.id);
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
            yield { type: "sdk", sdk: { type: "assistant", message: { content: f.message.content } } as RunEnvelope };
          } else if (r === "tool") {
            yield { type: "sdk", sdk: { type: "user", message: { content: f.message.content } } as RunEnvelope };
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
    const out = await sh(
      ["gh", "pr", "create", "--title", title, "--body", body, "--base", baseBranch, "--head", branch],
      worktreePath
    );
    const m = out.match(/https?:\/\/\S+/);
    return m ? m[0] : out.trim() || null;
  } catch (err) {
    console.warn(`gh pr create failed: ${describe(err)}`);
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
}

interface TurnResult {
  envelopes: RunEnvelope[];
  summary: string | null;
  sdkSessionId: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number;
}

async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult> {
  const { run, cwd, prompt, abort, author, onSdk } = args;

  const persona = await repo.getPersona(run.personaId ?? "implementor");
  if (!persona) {
    throw new Error(
      `Persona '${run.personaId ?? "implementor"}' not found; ` +
      `seed personas via db/seed-personas.ts.`
    );
  }

  // The model is chosen per-run, not by the persona. The model picker emits a
  // provider-qualified "provider/id"; a bare value (e.g. a legacy
  // TASK_ORCH_AGENT_MODEL) defaults to the anthropic provider.
  const rawModel = run.model ?? DEFAULT_MODEL;
  const [resolvedProvider, resolvedModelId] = rawModel.includes("/")
    ? (rawModel.split("/", 2) as [string, string])
    : ["anthropic", rawModel];
  const profileSpec = run.toolsProfile ?? persona.toolsProfile;

  const profileCtx: ProfileContext = {
    runId: run.id, run, author, taskId: run.taskId, planId: run.planId, cwd,
  };
  const { factories: profileFactories } = await resolveProfiles(profileSpec, profileCtx);
  // Always-on extensions (docs/agent-events.md §7): the event/timer/result
  // tools mount regardless of tools_profile — no profile misconfiguration can
  // strand an agent without a way to park, report, or be woken.
  const alwaysOnFactories = await alwaysOnExtensions(profileCtx);

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

  const extensions: Extension[] = [
    personaPromptFactory(personaForExt),
    personaMemoryFactory(personaForExt, run, repo, cwd),
    sandboxFactory(cwd, sandboxDbPath),
    abortBridgeFactory(abort),
    ...alwaysOnFactories,
    ...profileFactories,
  ];

  const envelopes: RunEnvelope[] = [];
  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  // Persist each mapped envelope as the turn streams. The shape is identical
  // across backends (RunEnvelope), so downstream is backend-agnostic.
  // Assistant messages are written per-envelope (not batched at end-of-turn) so
  // a page load mid-turn — hours into a long executor run — replays the full
  // history from the DB instead of showing only tool results.
  const onEvent = async (env: RunEnvelope) => {
    envelopes.push(env);
    onSdk?.(env);

    if (env.type === "system" && env.subtype === "init" && env.session_id) {
      sdkSessionId = env.session_id;
      await db.update(agentSessions)
        .set({ sdkSessionId })
        .where(eq(agentSessions.id, run.id));
    }

    if (env.type === "assistant" && env.message?.content) {
      const blocks = env.message.content;
      if (blocks.length > 0) await persistMessage(run.id, "agent", blocks as any);
      const text = assistantText(blocks as SdkContentBlock[]);
      if (text) lastAssistantText = text;
    }

    if (env.type === "user" && env.message?.content) {
      const results = toolResults(env.message.content as SdkContentBlock[]);
      if (results.length > 0) await persistMessage(run.id, "tool", results as any);
    }

    if (env.type === "result") {
      if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
      inputTokens = env.usage?.input_tokens ?? inputTokens;
      outputTokens = env.usage?.output_tokens ?? outputTokens;
    }
  };

  const backend = await getBackend();
  const resumeToken = run.sdkSessionId ?? null;
  const turnArgs = {
    cwd,
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
    prompt,
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
    outcome = await backend.runTurn({ ...turnArgs, resumeToken });
  } catch (err) {
    if (resumeToken && !abort.signal.aborted && isMissingSessionError(err)) {
      await persistMessage(run.id, "system", [
        {
          type: "text",
          text: `Previous session context could not be restored (${describe(err)}); continuing with a fresh session.`,
        },
      ]);
      outcome = await backend.runTurn({ ...turnArgs, resumeToken: null });
    } else {
      throw err;
    }
  }

  return {
    envelopes: envelopes as any,
    summary: summary ?? lastAssistantText ?? outcome.summary,
    // outcome.resumeToken is authoritative (backend-tagged); fall back to the
    // session id observed mid-turn, then the prior token.
    sdkSessionId: outcome.resumeToken ?? sdkSessionId ?? run.sdkSessionId ?? null,
    totalCostUsd: outcome.totalCostUsd,
    inputTokens: inputTokens ?? outcome.inputTokens,
    outputTokens: outputTokens ?? outcome.outputTokens,
    turns: outcome.turns,
  };
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
  // FIX 5 (M19): enforce the dollar cap when the backend reports a cost. The
  // Claude backend reports cumulative total_cost_usd per session, so once it meets
  // or exceeds budgetMaxUsd the run is exhausted. pi runs remain effectively
  // uncapped here: pi exposes no cost surface (totalCostUsd is null), so this
  // condition never trips for them. Column kept for historical data (see SCHEMA.md).
  if (
    run.budgetMaxUsd != null &&
    result.totalCostUsd != null &&
    result.totalCostUsd >= run.budgetMaxUsd
  ) {
    return true;
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
async function emitTerminalChildEvent(runId: number): Promise<void> {
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

/** Fresh turn-end read of the columns tools mutate mid-turn (§6.1 contract). */
async function readTurnEndState(
  runId: number
): Promise<{ status: SessionStatus; parkReason: string | null; result: unknown }> {
  const row = (
    await db
      .select({
        status: agentSessions.status,
        parkReason: agentSessions.parkReason,
        result: agentSessions.result,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, runId))
  )[0];
  return {
    status: (row?.status ?? "running") as SessionStatus,
    parkReason: row?.parkReason ?? null,
    result: row?.result ?? null,
  };
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
}

/**
 * Turn-end landing decision (§6.1) — the parking contract with the tools
 * layer, pure so it's unit-testable. Priority:
 *   1. result written this turn → the tool's terminal status if it already
 *      wrote one; else failed for raise-shaped payloads ({code}/status:
 *      'failed'), completed otherwise.
 *   2. a cancel/close that raced in wins (the caller's WHERE guard is the
 *      real protection; this keeps the decision honest too).
 *   3. budget exhaustion beats parking — an exhausted run must not sleep.
 *   4. park_reason set on a goal-driven (non-chat) run that would otherwise
 *      land completed/idle → 'parked'. Chat runs keep their idle behavior.
 *   5. otherwise the legacy default.
 */
export function decideTurnEndStatus(i: TurnEndDecisionInput): SessionStatus {
  if (i.result != null) {
    if (isTerminalStatus(i.freshStatus)) return i.freshStatus;
    const r = i.result as { status?: unknown; code?: unknown };
    const failedish =
      typeof i.result === "object" &&
      i.result !== null &&
      (r.status === "failed" || typeof r.code === "string");
    return failedish ? "failed" : "completed";
  }
  if (i.freshStatus === "cancelled" || i.freshStatus === "closed") return i.freshStatus;
  if (i.budgetHit) return "budget_exhausted";
  if (
    i.parkReason != null &&
    i.goal !== "<chat>" &&
    (i.defaultStatus === "completed" || i.defaultStatus === "idle")
  ) {
    return "parked";
  }
  return i.defaultStatus;
}

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
 * events (owner + supervisor; control-class rows are excluded inside the
 * claim primitive), quarantine any poison event (§6.5), persist ONE
 * agent_messages row (role 'system') carrying a single event_digest block,
 * stamp the claimed rows with that frame id, and return the rendered digest
 * text for the turn's prompt. Returns null when nothing was claimable.
 *
 * PRECONDITION: the caller is inside the run's turn (per-run lock / owned
 * runner) — the same invariant claimInboxEvents documents.
 *
 * Known window: claimInboxEvents commits its own transaction, so a crash
 * between the claim and the frame insert leaves those events 'injected' with
 * no frame (they remain auditable in inbox_events, and the render below still
 * reaches the model via the returned prompt text on the non-crash paths).
 * Folding claim + insert into one transaction needs a tx-aware claim
 * primitive; deliberately deferred rather than duplicating the claim SQL here.
 */
export async function injectPendingInboxEvents(runId: number): Promise<string | null> {
  let claimed;
  try {
    claimed = await claimInboxEvents(runId, { audiences: ["owner", "supervisor"] });
  } catch {
    return null; // never block a turn on the inbox
  }
  if (claimed.length === 0) return null;
  const envelopes: EventEnvelope[] = [];
  for (const row of claimed) {
    try {
      envelopes.push(toEnvelope(row));
    } catch (err) {
      // Poison event (§6.5): quarantine with the reason and proceed with the rest.
      await quarantineEvent(row.id, describe(err)).catch(() => {});
    }
  }
  if (envelopes.length === 0) return null;
  const block = buildEventDigestBlock(envelopes);
  try {
    const frame = await persistMessage(runId, "system", [block as unknown as SdkContentBlock]);
    await setClaimTurn(envelopes.map((e) => e.event_id), frame.id);
  } catch {
    // Frame persistence failed post-claim (see the docstring window); the
    // digest still reaches the model via the returned prompt text.
  }
  return renderEventDigest(block);
}

// ──────────────────────────────────────────────────────────
// Persistence helpers
// ──────────────────────────────────────────────────────────

async function persistMessage(
  runId: number,
  role: MessageRow["role"],
  content: SdkContentBlock[]
): Promise<MessageRow> {
  const inserted = await db
    .insert(agentMessages)
    .values({
      runId,
      role,
      content: JSON.stringify(content),
      createdAt: new Date(),
    })
    .returning();
  return hydrateMessage(inserted[0]);
}

async function setStatus(runId: number, status: SessionStatus) {
  await db.update(agentSessions).set({ status }).where(eq(agentSessions.id, runId));
  await emitStatus(runId, status);
  // Child lifecycle producer (§3.1): any terminal transition on a child run
  // becomes an inbox event for its parent. Deduped per (run, attempt), so the
  // defensive hook here and the explicit turn-end call sites can't double-emit.
  if (isTerminalStatus(status)) void emitTerminalChildEvent(runId);
}

// ──────────────────────────────────────────────────────────
// Liveness lease (heartbeat) + orphan recovery
// ──────────────────────────────────────────────────────────

/** Statuses that mean "a turn is in flight"; the only ones a heartbeat covers.
 *  'parked' (like 'idle') is deliberately NOT a lease status: a parked run has
 *  no worker and no heartbeat and that is HEALTHY (§6.1) — the reaper
 *  (reconcileOrphanedRuns) and repairAbortedRun therefore never touch it. */
const LEASE_STATUSES: SessionStatus[] = ["running", "preparing", "pushing", "opening_pr"];

/** How often a live turn bumps its heartbeat. */
const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * Age past which an active-status run is considered orphaned. Must comfortably
 * exceed HEARTBEAT_INTERVAL_MS and any plausible pause between bumps (the
 * interval keeps ticking even while a slow model/tool call is awaited, so this
 * only needs slack for scheduling jitter / GC pauses).
 */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/** Bump a run's heartbeat to now. Best-effort; a missed bump just risks a reap. */
async function touchHeartbeat(runId: number): Promise<void> {
  await db.update(agentSessions)
    .set({ heartbeatAt: new Date() })
    .where(eq(agentSessions.id, runId));
}

/**
 * Open the liveness lease and keep it fresh for the whole active period of a
 * turn/worker (prepare → turn → push/PR). Returns the interval handle; the
 * caller MUST clear it (in a finally) when the active period ends. The interval
 * keeps ticking even while a slow model/tool call is awaited, so a long-but-live
 * turn is never mistaken for an orphan by isLeaseLive()/reconcileOrphanedRuns().
 */
function startHeartbeat(runId: number): ReturnType<typeof setInterval> {
  // touchHeartbeat is async now; keep it fire-and-forget but swallow rejections
  // so a transient DB blip can't surface as an unhandled rejection.
  void touchHeartbeat(runId).catch(() => {});
  return setInterval(() => void touchHeartbeat(runId).catch(() => {}), HEARTBEAT_INTERVAL_MS);
}

/**
 * Fresh read of the cross-process cancel flag. cancel() sets `cancel_requested`
 * on the row; a detached worker (which can't see the web process's
 * AbortController) polls this at heartbeat cadence to abort its own turn.
 */
export async function isCancelRequested(runId: number): Promise<boolean> {
  const row = (await db
    .select({ c: agentSessions.cancelRequested })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId)))[0];
  return row?.c === 1;
}

/**
 * Like startHeartbeat, but the same interval that keeps the liveness lease fresh
 * also polls the cross-process cancel flag and aborts the turn when it flips.
 * Used by the workers a detached run process actually executes in
 * (append/runReview/runExecute) so a UI/`/stop` cancel — which only writes the
 * DB flag cross-process — still stops the turn within one heartbeat interval.
 * Callers thread their turn's AbortController through `abort`.
 */
function startHeartbeatWithCancel(
  runId: number,
  abort: AbortController
): ReturnType<typeof setInterval> {
  void touchHeartbeat(runId).catch(() => {});
  // The interval body is async and does DB I/O (touchHeartbeat + isCancelRequested);
  // wrap it so a transient DB blip can't surface as an unhandled rejection (which,
  // with no global handler, can crash the worker under Node's default). Mirrors the
  // guard on startHeartbeat above.
  return setInterval(() => {
    void (async () => {
      await touchHeartbeat(runId);
      if ((await isCancelRequested(runId)) && !abort.signal.aborted) {
        abort.abort();
        // Event system (§6.6): the abort IS the enforcement of the
        // run.cancel_requested control event — acknowledge its inbox row so
        // the next digest can show WHY the previous turn ended.
        void markControlInjected(runId, "run.cancel_requested").catch(() => {});
      }
    })().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}

/** True when this run holds a live lease: active status with a fresh heartbeat. */
export function isLeaseLive(
  run: { status: string; heartbeatAt: Date | null },
  now = Date.now()
): boolean {
  if (!LEASE_STATUSES.includes(run.status as SessionStatus)) return false;
  return run.heartbeatAt != null && now - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS;
}

/**
 * True when a worker container owns this run and is still alive — regardless of
 * status. Unlike isLeaseLive, this stays true for a long-lived chat worker sitting
 * at status='idle' BETWEEN turns (idle is not a lease status): it holds
 * worker_scope and keeps its heartbeat fresh while idle-waiting for the next
 * message. The server uses this to decide notify-only (worker will pick up the
 * run_input) vs dispatch a fresh worker.
 */
export function isWorkerLive(
  run: { workerScope: string | null; heartbeatAt: Date | null },
  now = Date.now()
): boolean {
  return (
    run.workerScope != null &&
    run.heartbeatAt != null &&
    now - run.heartbeatAt.getTime() < HEARTBEAT_STALE_MS
  );
}

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
    await db.update(agentSessions)
      .set({ status: "idle", completedAt: null })
      .where(eq(agentSessions.id, runId));
    await emitStatus(runId, "idle");
  } else {
    await setError(runId, "Turn aborted before it finished (client disconnected).");
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
  const now = Date.now();
  const rows = await db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.status, LEASE_STATUSES));
  let reaped = 0;
  for (const row of rows) {
    if (isLeaseLive(row, now)) continue; // fresh lease → owned by a live process
    // Detached mode: a worker that died mid-turn (host reboot / OOM) on a
    // resumable worktree run is handed to a fresh detached worker instead of
    // being failed. A worktree run is resumable — its branch/worktree persist
    // and it has an SDK session to resume from — so this mirrors
    // isResumableWorktreeRun's cwdStrategy="worktree" predicate (evaluated here
    // via isImplementWorktree, since the row is still in a *lease* status and
    // isResumableWorktreeRun only accepts post-reap terminal statuses). Clear
    // the stale claim first so dispatchRun can re-claim the row.
    // Containerized workers re-clone from the repo-cache, so the branch (pushed
    // to GitHub) + an SDK session is enough — the host worktree is gone with the
    // dead container. Host/dev mode still requires the on-disk worktree.
    const containerized = !!process.env.TASK_ORCH_WORKER_IMAGE;
    const resumable =
      runDispatch.detachedRunsEnabled() &&
      isImplementWorktree(row) &&
      !!row.sdkSessionId &&
      (containerized ? !!row.branch : !!row.worktreePath && existsSync(row.worktreePath));
    if (resumable) {
      await db.update(agentSessions)
        .set({ workerScope: null })
        .where(eq(agentSessions.id, row.id));
      void runDispatch.dispatchRun(row.id).catch(() => {});
      reaped++;
      continue;
    }
    if (row.goal === "<chat>") {
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
      await setError(row.id, "Interrupted by a process restart before the turn finished.");
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
  info: { exitCode: number | null; oomKilled: boolean; containerName: string }
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
  const released = await db
    .update(agentSessions)
    .set({ workerScope: null, workerPid: null, heartbeatAt: null })
    .where(and(eq(agentSessions.id, runId), eq(agentSessions.workerScope, info.containerName)));
  if (released.count === 0) return; // lost the race — another handler owns it

  // Parked chat run whose worker wound down (idle timeout): the claim release
  // above is the whole job — it's already resumable on the next message.
  if (row.status === "idle") return;

  const oom = info.oomKilled || info.exitCode === 137;
  const why =
    info.exitCode == null
      ? "its container is gone"
      : `its container exited with code ${info.exitCode}${oom ? " — killed at its memory cap (OOM)" : ""}`;

  const containerized = !!process.env.TASK_ORCH_WORKER_IMAGE;
  const resumable =
    runDispatch.detachedRunsEnabled() &&
    isImplementWorktree(row) &&
    !!row.sdkSessionId &&
    (containerized ? !!row.branch : !!row.worktreePath && existsSync(row.worktreePath));
  // §3.1: durable infra-death fact for the parent, whatever policy follows
  // below (re-dispatch / idle / failed). Deduped per container so the events
  // monitor and the sweep racing each other produce ONE event, not two.
  void emitChildDied(runId, {
    exitCode: info.exitCode,
    oomKilled: oom,
    scopeKey: info.containerName,
    resumable,
  });
  if (resumable && !oom) {
    // AWAIT the re-dispatch: its atomic claim (status→preparing, fresh heartbeat)
    // must land before this pump tick's later reconcileOrphanedRuns pass runs, or
    // that pass would see a lease-status row with a null heartbeat, judge it an
    // orphan, and re-dispatch it a SECOND time.
    await runDispatch.dispatchRun(runId).catch(() => {});
    return;
  }
  if (row.goal === "<chat>") {
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
 * Count runs currently occupying a worker slot: a non-null worker_scope AND an
 * active (lease) status. This is the admission gate's "in-flight" number.
 * Counting 'preparing' rows charges a just-claimed worker its full memory
 * reservation immediately (before its RSS ramps up), closing the dispatch race.
 */
export async function countInFlightWorkers(): Promise<number> {
  // Count runs a LIVE worker owns — worker_scope set AND a fresh heartbeat —
  // regardless of status. A long-lived chat worker parked at 'idle' between turns
  // still holds a resident container + its memory, so it must count against the
  // admission budget; a dead worker's stale claim (expired heartbeat) must not.
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        isNotNull(agentSessions.workerScope),
        gt(agentSessions.heartbeatAt, new Date(Date.now() - HEARTBEAT_STALE_MS))
      )
    );
  return rows.length;
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
      parentWorkerScope: pendingParent.workerScope,
      parentHeartbeatAt: pendingParent.heartbeatAt,
    })
    .from(agentSessions)
    .leftJoin(pendingParent, eq(agentSessions.parentRunId, pendingParent.id))
    .where(eq(agentSessions.status, "pending"))
    .orderBy(asc(agentSessions.id));

  const liveParentChildren: number[] = [];
  const rest: number[] = [];
  for (const r of rows) {
    const parentLive = isWorkerLive({ workerScope: r.parentWorkerScope, heartbeatAt: r.parentHeartbeatAt });
    (parentLive ? liveParentChildren : rest).push(r.id);
  }
  return [...liveParentChildren, ...rest];
}

async function setError(runId: number, error: string) {
  await db.update(agentSessions)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(agentSessions.id, runId));
  await emitStatus(runId, "failed", { error });
  // Child lifecycle producer (§3.1): failed → child.exception for the parent
  // (code 'unhandled' unless a raise-tool payload sits in agent_runs.result).
  void emitTerminalChildEvent(runId);
}

async function emitStatus(runId: number, status: SessionStatus, extra?: Record<string, unknown>) {
  // Mirror to agent_events so legacy /sessions UI keeps showing transitions.
  try {
    await db.insert(agentEvents)
      .values({
        sessionId: runId,
        type: "status",
        payload: JSON.stringify({ status, ...(extra ?? {}) }),
        createdAt: new Date(),
      });
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

function hydrateRun(row: typeof agentSessions.$inferSelect): RunRow {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status as SessionStatus,
    origin: row.taskId !== null ? "task" : "chat",
    taskId: row.taskId,
    planId: row.planId,
    repoId: row.repoId,
    parentRunId: row.parentRunId,
    toolsProfile: row.toolsProfile,
    cwdStrategy: row.cwdStrategy as CwdStrategy,
    model: row.model,
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
    heartbeatAt: row.heartbeatAt ?? null,
    workerScope: row.workerScope ?? null,
    workerPid: row.workerPid ?? null,
    cancelRequested: row.cancelRequested ?? null,
    attempt: row.attempt ?? 1,
    result: row.result ?? null,
    parkReason: row.parkReason ?? null,
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
  return { id: row.id, runId: row.runId, role, content, createdAt: row.createdAt };
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
}

/** /runs UI lister — a thin, narrower-typed wrapper over list(). */
export async function listRuns(filters: RunFilters = {}): Promise<RunRow[]> {
  return await list(filters);
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
