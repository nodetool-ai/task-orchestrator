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
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";

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
import { parsePrUrl } from "./gh-url";
import { assistantText, toolResults, type SdkContentBlock } from "./sdk-message";
import type { AgentSessionFull, RepositoryRow, SessionStatus } from "./types";
import { isTerminalStatus, SESSION_STATUSES } from "./types";
import { resolveProfiles, type ProfileContext } from "./profiles";
import { type RunEnvelope } from "./pi-event-mapper";
import { getBackend, type Extension } from "./agent-backend";
import { sandboxFactory } from "./extensions/sandbox";
import { personaPromptFactory } from "./extensions/persona-prompt";
import { personaMemoryFactory } from "./extensions/persona-memory";
import { abortBridgeFactory } from "./extensions/abort-bridge";
import { linkSharedWorktreeArtifacts } from "./worktree-env";

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
// CRUD: create / list / get
// ──────────────────────────────────────────────────────────

export function create(input: CreateRunInput): RunRow {
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
    const t = repo.getTask(input.taskId);
    if (t?.repoId) repoId = t.repoId;
  }
  if (!repoId && input.planId) {
    const p = repo.getPlan(input.planId);
    if (p?.repos.length) repoId = p.repos[0].id;
  }
  if (!repoId && goal === "<chat>") {
    repoId = repo.defaultRepoId();
  }

  if (repoId && !repo.getRepository(repoId)) {
    throw new repo.RepoError(`Repository ${repoId} not found`, 404);
  }
  if (input.taskId && !repo.getTask(input.taskId)) {
    throw new repo.RepoError(`Task ${input.taskId} not found`, 404);
  }
  if (input.planId && !repo.getPlan(input.planId)) {
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
  if (!repo.getPersona(personaId)) {
    // persona_id is a foreign key; surface a clear 404 instead of letting the
    // insert fail with an opaque "FOREIGN KEY constraint failed".
    throw new repo.RepoError(`Persona '${personaId}' not found`, 404);
  }
  const effectiveModel = input.model ?? DEFAULT_MODEL;

  const inserted = db
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
    .returning()
    .all();
  const run = hydrateRun(inserted[0]);

  // A worktree run with a task is that task's attached session — point
  // `tasks.attached_run_id` at it (for both the kicked-off Agent path and the
  // deferred chat-box path). `ifUnset` means executor-spawned runs only adopt an
  // empty slot. Bare worktree runs (no task, e.g. tests) skip this.
  if (goal !== "<chat>" && cwdStrategy === "worktree" && input.taskId) {
    repo.attachRunToTask(input.taskId, run.id, { ifUnset: true });
  }

  // Implement-style kickoff: run the first turn through the unified engine
  // (runs.append → branch create → turn → conditional push/PR). Deferred runs
  // (chat box, bare test runs) skip this and wait for the user's first message.
  if (!input.defer && goal !== "<chat>" && cwdStrategy === "worktree") {
    // taskId presence validated before the insert above.
    const task = repo.getTask(input.taskId!)!;
    void kickoffFirstTurn(
      run.id,
      input.initialPrompt ?? buildImplementPrompt(task),
      input.baseBranch
    );
  }

  // Review-style runs: spin up a worktree at the PR's head ref and run a
  // single agent turn against it. Requires a prUrl on the run (validated above).
  if (!input.defer && cwdStrategy === "worktree_at_pr") {
    void runReview(run.id, input.prUrl!, input.initialPrompt ?? null);
  }

  // Plan-executor runs: a single long-running agent that drives a whole plan
  // (implement → review → merge) by spawning child runs. Operates at the repo
  // root (no worktree of its own); children make their own worktrees.
  if (!input.defer && goal === "<execute>" && input.planId) {
    void runExecute(run.id, input.planId, input.initialPrompt ?? null);
  }

  return run;
}

export function list(filter: ListFilter = {}): RunRow[] {
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
  const rows = where ? q.where(where).all() : q.all();
  return rows.map(hydrateRun);
}

const TERMINAL_STATUS_LIST: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

export function get(id: number): RunRow | null {
  const row = db.select().from(agentSessions).where(eq(agentSessions.id, id)).get();
  return row ? hydrateRun(row) : null;
}

export function listMessages(runId: number): MessageRow[] {
  return db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId))
    .orderBy(asc(agentMessages.id))
    .all()
    .map(hydrateMessage);
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
    let run = get(input.runId);
    if (!run) {
      yield { type: "error", error: `Run ${input.runId} not found` };
      return;
    }
    if (runners.has(input.runId) || isLeaseLive(run)) {
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

    const userMsg = persistMessage(run.id, input.role === "system" ? "system" : "user", [
      { type: "text", text: input.text },
    ]);
    yield { type: "user_message", message: userMsg };

    setStatus(run.id, "running");
    // Open the liveness lease and keep it fresh for the whole active period
    // (prepare → turn → push/PR). The interval ticks even while a slow model or
    // tool call is awaited, so a long-but-alive turn is never mistaken for an
    // orphan. Cleared in the finally below.
    heartbeat = startHeartbeat(input.runId);

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
        repairAbortedRun(input.runId);
        yield { type: "done" };
        return;
      }
      const msg = describe(err);
      setError(run.id, msg);
      yield { type: "error", error: msg };
      return;
    }

    // A cancel()/close() that landed during prep already wrote a terminal row
    // (and cancel() removed the worktree). Bail before spending a full model
    // turn on a run the user already stopped.
    if (abort.signal.aborted) {
      repairAbortedRun(input.runId);
      yield { type: "done" };
      return;
    }

    let result: TurnResult;
    try {
      result = await runOneTurn({
        run,
        cwd,
        prompt: input.text,
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
        repairAbortedRun(input.runId);
        yield { type: "done" };
        return;
      }
      const msg = describe(err);
      setError(run.id, msg);
      yield { type: "error", error: msg };
      return;
    }

    // The turn resolved normally but the signal may have aborted right at the
    // end (backend swallowed it). Respect any terminal row the aborter wrote /
    // repair a stranded lease instead of overwriting it below.
    if (abort.signal.aborted) {
      repairAbortedRun(input.runId);
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
        persistMessage(run.id, "system", [
          { type: "text", text: `Push/PR sync failed: ${describe(err)}` },
        ]);
      }
    }

    // Worktree runs (the task's attached session) land at `completed` after each
    // turn — terminal so the executor's await_session resolves, but resumable
    // via the guard above. Chat/none runs land `idle`. Budget caps win.
    const budgetHit = checkBudget(run, result);
    const landsCompleted = isImplementWorktree(run);
    const nextStatus: SessionStatus = budgetHit
      ? "budget_exhausted"
      : landsCompleted
        ? "completed"
        : "idle";
    // Review-style runs surface a structured verdict in `outcome`. Gated on
    // goal so chat/implement append flows are unaffected.
    const outcomeUpdate =
      run.goal === "<review>"
        ? extractReviewOutcome(result.summary) ?? run.outcome
        : run.outcome;
    // Conditional on the row NOT already being terminal-by-user: a cancel()/
    // close() that raced in right as the turn ended must win. Without the WHERE
    // guard this update would resurrect a 'cancelled'/'closed' run.
    const finalUpdate = db.update(agentSessions)
      .set({
        status: nextStatus,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
        outcome: outcomeUpdate,
        prUrl: prUrlUpdate,
        completedAt: budgetHit || landsCompleted ? new Date() : null,
      })
      .where(
        and(
          eq(agentSessions.id, run.id),
          notInArray(agentSessions.status, ["cancelled", "closed"])
        )
      )
      .run();
    // Tell live SSE subscribers (the run-view in the browser) that the turn
    // ended — emit BEFORE dropping the runner (in the finally) so the bus still
    // exists. Only emit when we actually wrote the row; if a cancel()/close()
    // won the race the update was a no-op and the aborter already emitted.
    if (finalUpdate.changes > 0) emitStatus(run.id, nextStatus);

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

export function cancel(id: number): RunRow {
  const run = get(id);
  if (!run) throw new repo.RepoError(`Run ${id} not found`, 404);
  if (isTerminalStatus(run.status)) return run;
  const runner = runners.get(id);
  runner?.abort.abort();
  db.update(agentSessions)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(agentSessions.id, id))
    .run();
  emitStatus(id, "cancelled");
  closeBus(id);
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, repoRoot(run)).catch(() => {});
  }
  return get(id)!;
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
export function interrupt(id: number): boolean {
  const run = get(id);
  if (!run) return false;
  const runner = runners.get(id);
  if (!runner) return false; // nothing in flight
  runner.abort.abort();
  // Keep the worktree intact (no cleanupWorktree) so the next message resumes
  // instantly. Clear completedAt: an idle run is mid-conversation, not finished.
  db.update(agentSessions)
    .set({ status: "idle", completedAt: null })
    .where(eq(agentSessions.id, id))
    .run();
  emitStatus(id, "idle");
  return true;
}

export function close(id: number): RunRow {
  const run = get(id);
  if (!run) throw new repo.RepoError(`Run ${id} not found`, 404);
  if (run.status === "closed") return run;
  // If a turn is in flight, cancel it first.
  const runner = runners.get(id);
  if (runner) runner.abort.abort();
  db.update(agentSessions)
    .set({ status: "closed", completedAt: new Date() })
    .where(eq(agentSessions.id, id))
    .run();
  closeBus(id);
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, repoRoot(run)).catch(() => {});
  }
  return get(id)!;
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
  const run = get(runId);
  if (!run) return;
  if (isLive(runId)) return;
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
  // while we waited).
  if (isLive(runId)) return;
  let release!: () => void;
  lock.busy = new Promise<void>((res) => (release = res));

  const abort = new AbortController();
  const bus = new EventEmitter();
  runners.set(runId, { abort, bus });
  // Keep the liveness lease fresh so this webhook-driven follow-up turn isn't
  // treated as an orphan by append()/reconcileOrphanedRuns() mid-turn.
  const heartbeat = startHeartbeat(runId);

  try {
    persistMessage(runId, "system", [{ type: "text", text: prompt }]);
    setStatus(runId, "running");

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
        persistMessage(runId, "system", [
          { type: "text", text: `Follow-up: git push failed: ${describe(err)}` },
        ]);
      }
    }

    db.update(agentSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId))
      .run();
    emitStatus(runId, "completed");
  } catch (err) {
    if (!abort.signal.aborted) setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
    cleanupWorktree(run.worktreePath, repoRoot(run)).catch(() => {});
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
function resolveRepo(run: { repoId: string | null; taskId: string | null }): RepositoryRow | null {
  if (run.repoId) {
    const r = repo.getRepository(run.repoId);
    if (r) return r;
  }
  if (run.taskId) {
    const r = repo.resolveRepoForTask(run.taskId);
    if (r) return r;
  }
  return repo.defaultRepo();
}

function repoRoot(run: { repoId: string | null; taskId: string | null }): string {
  const r = resolveRepo(run);
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
  if (run.cwdStrategy === "none" || run.cwdStrategy === "repo") {
    return validateCwd(repoRoot(run), { runId: run.id, repoId: run.repoId });
  }
  // worktree / worktree_at_pr: re-materialize if missing.
  if (!run.branch || !run.worktreePath) {
    throw new Error(
      `Run #${run.id} has cwd_strategy=${run.cwdStrategy} but no branch/worktree_path recorded yet.`
    );
  }
  const root = repoRoot(run);
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
function repoDefaultBranch(run: { repoId: string | null; taskId: string | null }): string {
  return resolveRepo(run)?.defaultBranch ?? "main";
}

/**
 * First turn of a worktree run: create its branch (`claude/<task>-<run>`) and
 * worktree off the base branch, persist them, and move the task to in_progress.
 * No-op once a branch exists (later turns re-materialize via prepareCwd).
 */
async function ensureWorktreeBranch(run: RunRow, baseBranch?: string): Promise<RunRow> {
  if (run.cwdStrategy !== "worktree" || run.branch) return run;
  const base = baseBranch?.trim() || repoDefaultBranch(run);
  const root = repoRoot(run);
  const worktreeRoot = resolve(root, ".worktrees");
  const branch = worktreeBranchName(run);
  const worktreePath = resolve(worktreeRoot, String(run.id));
  await mkdir(worktreeRoot, { recursive: true });
  await sh(["git", "worktree", "add", "-b", branch, worktreePath, base], root);
  await linkSharedWorktreeArtifacts(worktreePath, root);
  const taskRepoId = run.taskId ? repo.getTask(run.taskId)?.repoId ?? null : null;
  db.update(agentSessions)
    .set({ branch, worktreePath, repoId: run.repoId ?? taskRepoId })
    .where(eq(agentSessions.id, run.id))
    .run();
  // Task-attached (implement) runs move their task to in_progress; taskless chat
  // worktrees have nothing to transition.
  const task = run.taskId ? repo.getTask(run.taskId) : null;
  if (run.taskId && task && (task.state === "todo" || task.state === "blocked")) {
    try {
      repo.transitionTask(run.taskId, {
        state: "in_progress",
        assignee: task.assignee ?? "claude-agent",
        note: `Started agent run #${run.id}.`,
      });
    } catch {
      // Best-effort.
    }
  }
  return get(run.id)!;
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
  const base = baseBranch?.trim() || repoDefaultBranch(run);
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
  const task = repo.getTask(run.taskId);
  if (!task) return null;
  const prUrl = await openPr({ task, branch: run.branch, baseBranch: base, worktreePath: cwd, summary });
  if (prUrl) {
    try {
      repo.transitionTask(run.taskId, {
        state: "review",
        note: `Agent finished. PR: ${prUrl}`,
      });
    } catch (err) {
      repo.addNote(run.taskId, "claude-agent", `Could not transition to review: ${describe(err)}`);
    }
  }
  return prUrl ?? run.prUrl;
}

/** Fire a worktree run's first turn through the unified engine, server-side. */
async function kickoffFirstTurn(
  runId: number,
  prompt: string,
  baseBranch?: string
): Promise<void> {
  try {
    for await (const ev of append({ runId, role: "user", text: prompt, baseBranch })) {
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
  // orphan and take it over / mark it failed mid-turn.
  const heartbeat = startHeartbeat(runId);

  let run = get(runId)!;
  const root = repoRoot(run);
  const worktreeRoot = resolve(root, ".worktrees");
  const branch = `review-${runId}`;
  const worktreePath = resolve(worktreeRoot, `review-${runId}`);

  try {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      setError(runId, `Could not parse PR url: ${prUrl}`);
      runners.delete(runId);
      return;
    }

    setStatus(runId, "preparing");
    await mkdir(worktreeRoot, { recursive: true });

    // Fetch the PR head ref into a local ref, then create a worktree on a
    // throwaway review branch pointing at FETCH_HEAD. Equivalent to
    // `gh pr checkout` but keeps git as the source of truth (gh's checkout
    // mutates the current working tree which we don't want here).
    try {
      await sh(
        ["git", "fetch", "origin", `pull/${parsed.number}/head`],
        root
      );
    } catch (err) {
      setError(
        runId,
        `git fetch failed for ${prUrl}: ${describe(err)}. Is the PR's origin remote configured?`
      );
      runners.delete(runId);
      return;
    }
    await sh(
      ["git", "worktree", "add", "-b", branch, worktreePath, "FETCH_HEAD"],
      root
    );
    await linkSharedWorktreeArtifacts(worktreePath, root);
    db.update(agentSessions)
      .set({ branch, worktreePath })
      .where(eq(agentSessions.id, runId))
      .run();
    run = get(runId)!;

    setStatus(runId, "running");
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

    db.update(agentSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        outcome,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId))
      .run();
    emitStatus(runId, "completed");

    // An approving verdict marks the task done. The outcome is the JSON
    // verdict block extracted above (or a fallback first line, which won't
    // parse — so a non-approve outcome simply leaves the task untouched).
    if (run.taskId && parseReviewVerdict(outcome) === "approve") {
      try {
        repo.transitionTask(run.taskId, {
          state: "done",
          note: `Review run #${runId} approved the PR.`,
        });
      } catch (err) {
        repo.addNote(
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
    setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
    cleanupWorktree(worktreePath, root).catch(() => {});
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
  // append()/reconcileOrphanedRuns() never treat this live run as an orphan.
  const heartbeat = startHeartbeat(runId);

  let run = get(runId)!;

  try {
    const plan = repo.getPlan(planId);
    if (!plan) {
      setError(runId, `Plan ${planId} disappeared before execution could start`);
      runners.delete(runId);
      return;
    }

    setStatus(runId, "running");
    // No worktree of its own — operate at the repo root so gh_pr tools shell
    // out against the real checkout. Children create their own worktrees.
    const cwd = await prepareCwd(run);
    // The execute scaffold (orchestration loop + task list) always runs; an
    // operator-supplied prompt is appended as steering guidance rather than
    // replacing it, so the executor never loses its core instructions.
    const base = buildExecutePrompt(plan, repo.listTasks({ planId }));
    const extra = initialPrompt?.trim();
    const prompt = extra ? `${base}\n\n## Operator instructions\n\n${extra}` : base;
    // Persist the kickoff prompt so a page load shows what this executor was
    // asked to do — the executor is driven server-side, so unlike append()
    // there is no user message row anchoring the transcript.
    persistMessage(runId, "system", [{ type: "text", text: prompt }]);
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

    db.update(agentSessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
      })
      .where(eq(agentSessions.id, runId))
      .run();
    emitStatus(runId, "completed");

    // Fallback: if the agent drove every task to a terminal state but didn't
    // close the plan itself, mark the plan done.
    try {
      const tasks = repo.listTasks({ planId });
      const allClosed =
        tasks.length > 0 &&
        tasks.every((t) => t.state === "done" || t.state === "cancelled");
      const planNow = repo.getPlan(planId);
      if (allClosed && planNow && planNow.state === "accepted") {
        repo.updatePlan(planId, { state: "done" });
      }
    } catch {
      // Best-effort — the agent's own transition_plan is the primary path.
    }
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    setError(runId, describe(err));
  } finally {
    clearInterval(heartbeat);
    closeBus(runId);
    runners.delete(runId);
  }
}

interface OpenPrArgs {
  task: NonNullable<ReturnType<typeof repo.getTask>>;
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
  task: NonNullable<ReturnType<typeof repo.getTask>>,
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

  const persona = repo.getPersona(run.personaId ?? "implementor");
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
  const onEvent = (env: RunEnvelope) => {
    envelopes.push(env);
    onSdk?.(env);

    if (env.type === "system" && env.subtype === "init" && env.session_id) {
      sdkSessionId = env.session_id;
      db.update(agentSessions)
        .set({ sdkSessionId })
        .where(eq(agentSessions.id, run.id))
        .run();
    }

    if (env.type === "assistant" && env.message?.content) {
      const blocks = env.message.content;
      if (blocks.length > 0) persistMessage(run.id, "agent", blocks as any);
      const text = assistantText(blocks as SdkContentBlock[]);
      if (text) lastAssistantText = text;
    }

    if (env.type === "user" && env.message?.content) {
      const results = toolResults(env.message.content as SdkContentBlock[]);
      if (results.length > 0) persistMessage(run.id, "tool", results as any);
    }

    if (env.type === "result") {
      if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
      inputTokens = env.usage?.input_tokens ?? inputTokens;
      outputTokens = env.usage?.output_tokens ?? outputTokens;
    }
  };

  const backend = await getBackend();
  const outcome = await backend.runTurn({
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
    resumeToken: run.sdkSessionId ?? null,
    abort,
    prompt,
    onEvent,
  });

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
  // budgetMaxUsd is not enforced: pi exposes no cost surface (totalCostUsd is
  // null), and while the Claude backend does report total_cost_usd we keep the
  // cap dormant for parity. Column kept for historical data (see SCHEMA.md).
  return false;
}

// ──────────────────────────────────────────────────────────
// Persistence helpers
// ──────────────────────────────────────────────────────────

function persistMessage(
  runId: number,
  role: MessageRow["role"],
  content: SdkContentBlock[]
): MessageRow {
  const inserted = db
    .insert(agentMessages)
    .values({
      runId,
      role,
      content: JSON.stringify(content),
      createdAt: new Date(),
    })
    .returning()
    .all();
  return hydrateMessage(inserted[0]);
}

function setStatus(runId: number, status: SessionStatus) {
  db.update(agentSessions).set({ status }).where(eq(agentSessions.id, runId)).run();
  emitStatus(runId, status);
}

// ──────────────────────────────────────────────────────────
// Liveness lease (heartbeat) + orphan recovery
// ──────────────────────────────────────────────────────────

/** Statuses that mean "a turn is in flight"; the only ones a heartbeat covers. */
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
function touchHeartbeat(runId: number): void {
  db.update(agentSessions)
    .set({ heartbeatAt: new Date() })
    .where(eq(agentSessions.id, runId))
    .run();
}

/**
 * Open the liveness lease and keep it fresh for the whole active period of a
 * turn/worker (prepare → turn → push/PR). Returns the interval handle; the
 * caller MUST clear it (in a finally) when the active period ends. The interval
 * keeps ticking even while a slow model/tool call is awaited, so a long-but-live
 * turn is never mistaken for an orphan by isLeaseLive()/reconcileOrphanedRuns().
 */
function startHeartbeat(runId: number): ReturnType<typeof setInterval> {
  touchHeartbeat(runId);
  return setInterval(() => touchHeartbeat(runId), HEARTBEAT_INTERVAL_MS);
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
 * Repair a run whose in-flight turn was aborted. If cancel()/interrupt()/close()
 * already rewrote the row out of a lease status, we leave their terminal/idle
 * result alone. But a bare client-disconnect (req.signal → the append's abort)
 * aborts the turn with NO status rewrite, stranding the row in an active status
 * (it looks "in flight" forever and rejects every new message until the lease
 * goes stale). Repair that: chat/none runs return to `idle` (resumable next
 * message); everything else lands `failed`.
 */
function repairAbortedRun(runId: number): void {
  const cur = get(runId);
  if (!cur) return;
  // Not in a lease status → cancel()/interrupt()/close() already handled it.
  if (!LEASE_STATUSES.includes(cur.status)) return;
  if (cur.goal === "<chat>" || cur.cwdStrategy === "none") {
    db.update(agentSessions)
      .set({ status: "idle", completedAt: null })
      .where(eq(agentSessions.id, runId))
      .run();
    emitStatus(runId, "idle");
  } else {
    setError(runId, "Turn aborted before it finished (client disconnected).");
  }
}

/**
 * Demote runs left in an active status by a process that died mid-turn (e.g.
 * OOM-killed) — identified by a stale/absent heartbeat. Chat runs go back to
 * `idle` (resumable on the next message); others land `failed`. Safe to call on
 * every boot and concurrently across processes: a run genuinely live elsewhere
 * keeps its heartbeat fresh and is skipped. Returns the number reaped.
 */
export function reconcileOrphanedRuns(): number {
  const now = Date.now();
  const rows = db
    .select()
    .from(agentSessions)
    .where(inArray(agentSessions.status, LEASE_STATUSES))
    .all();
  let reaped = 0;
  for (const row of rows) {
    if (isLeaseLive(row, now)) continue; // fresh lease → owned by a live process
    if (row.goal === "<chat>") {
      setStatus(row.id, "idle");
    } else {
      setError(row.id, "Interrupted by a process restart before the turn finished.");
    }
    reaped++;
  }
  if (reaped > 0) console.log(`[runs] reconciled ${reaped} orphaned run(s) on boot`);
  return reaped;
}

function setError(runId: number, error: string) {
  db.update(agentSessions)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(agentSessions.id, runId))
    .run();
  emitStatus(runId, "failed", { error });
}

function emitStatus(runId: number, status: SessionStatus, extra?: Record<string, unknown>) {
  // Mirror to agent_events so legacy /sessions UI keeps showing transitions.
  try {
    db.insert(agentEvents)
      .values({
        sessionId: runId,
        type: "status",
        payload: JSON.stringify({ status, ...(extra ?? {}) }),
        createdAt: new Date(),
      })
      .run();
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
  };
}

function hydrateMessage(row: typeof agentMessages.$inferSelect): MessageRow {
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
export function listRuns(filters: RunFilters = {}): RunRow[] {
  return list(filters);
}

// Lookup any run by id, regardless of whether it's task-derived or
// chat-derived. lib/agent.getSession() filters to task-derived only and
// lib/chat.getChat() filters to chat-derived only; this is the un-filtered
// view for the /runs/[id] dispatcher.
export function getRun(id: number): RunRow | null {
  return get(id);
}

// Resolve a legacy chats.id (from before migration 0009) to the new
// agent_runs.id, for /chat/[id] → /runs/[id] redirects.
export function resolveLegacyChatId(chatId: number): number | null {
  const row = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.legacyChatId, chatId), isNotNull(agentSessions.legacyChatId)))
    .get();
  return row?.id ?? null;
}

// Group key for the /runs UI. Order of buckets is: Active (live work),
// Idle (chat runs and queued task runs waiting on a worker), Closed.
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
