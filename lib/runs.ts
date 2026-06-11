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
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { createAgentSession, SessionManager, AuthStorage, ModelRegistry, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

import { db } from "@/db";
import { agentEvents, agentMessages, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import { buildCliImplementPrompt, buildImplementPrompt, extractReviewOutcome } from "./run-templates";
import {
  checkClaudeCliAvailable,
  getHandle as getClaudeCliHandle,
  killTmuxSession,
  startClaudeCli,
  tmuxSessionName,
  type ClaudeCliDone,
  type ClaudeCliHandle,
  type ClaudeHookEvent,
} from "./claude-cli";
import { parsePrUrl } from "./gh-url";
import type { SdkContentBlock } from "./sdk-message";
import type { AgentSessionFull, SessionStatus } from "./types";
import { isTerminalStatus } from "./types";
import { resolveProfiles, type ProfileContext } from "./profiles";
import { mapPiEvent, type RunEnvelope } from "./pi-event-mapper";
import { sandboxFactory } from "./extensions/sandbox";
import { personaPromptFactory } from "./extensions/persona-prompt";
import { personaMemoryFactory } from "./extensions/persona-memory";
import { abortBridgeFactory } from "./extensions/abort-bridge";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "claude-sonnet-4-5";
const KEEP_WORKTREES = !!process.env.TASK_ORCH_KEEP_WORKTREES;

const SANDBOX_OPTS = {
  enabled: true as const,
  autoAllowBashIfSandboxed: true as const,
};

// ──────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────

export type Goal = "<implement>" | "<chat>" | "<review>" | (string & {});
export type CwdStrategy = "worktree" | "worktree_at_pr" | "repo" | "none";
export type Harness = "pi" | "claude_cli";

export interface Budget {
  maxTurns?: number;
  maxUsd?: number;
  maxSeconds?: number;
}

export interface CreateRunInput {
  goal: Goal;
  /** Execution harness: 'pi' (SDK, default) or 'claude_cli' (Claude Code in tmux). */
  harness?: Harness;
  toolsProfile?: string;
  cwdStrategy?: CwdStrategy;
  repoId?: string | null;
  taskId?: string | null;
  /** Plan a chat is scoped to (no effect on implement/review runs). */
  planId?: string | null;
  prUrl?: string | null;
  parentRunId?: number | null;
  model?: string | null;
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
  harness: Harness;
  /** Claude-CLI runs: tmux session name for the attach hint / cancel. */
  tmuxSession: string | null;
  /** Claude-CLI runs: Claude Code transcript JSONL path (from SessionStart hook). */
  transcriptPath: string | null;
  model: string | null;
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
  startedAt: Date;
  completedAt: Date | null;
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
  const cwdStrategy: CwdStrategy = input.cwdStrategy ?? (goal === "<chat>" ? "none" : "worktree");
  const harness: Harness = input.harness ?? "pi";
  const toolsProfile =
    input.toolsProfile ?? (goal === "<chat>" ? "orchestrator,repo_write" : "orchestrator,repo_write");
  const initialStatus: SessionStatus = input.defer || goal === "<chat>" ? "idle" : "pending";

  // The Claude CLI harness only implements the worktree implement flow
  // (one prompt → agent pushes + opens PR). Chats/reviews stay on pi.
  if (harness === "claude_cli" && (goal === "<chat>" || cwdStrategy !== "worktree")) {
    throw new repo.RepoError(
      "harness=claude_cli only supports implement-style runs (cwd_strategy=worktree).",
      400
    );
  }

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

  // Resolve the effective model. Priority: explicit input.model > persona's
  // configured model > TASK_ORCH_AGENT_MODEL env default. We persist the
  // resolved value so the UI and downstream consumers see what was actually
  // used, not a placeholder env value.
  const personaId = input.personaId ?? "implementor";
  const personaRow = repo.getPersona(personaId);
  const effectiveModel =
    input.model ?? personaRow?.modelId ?? DEFAULT_MODEL;

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
      harness,
      model: effectiveModel,
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

  // Implement-style runs (goal != '<chat>', cwdStrategy='worktree') kick
  // off the full lifecycle (worktree → SDK → push → PR). Chat-style runs
  // sit at 'idle' until the first runs.append().
  if (!input.defer && goal !== "<chat>" && cwdStrategy === "worktree") {
    if (!input.taskId) {
      throw new repo.RepoError(
        "Implement-style runs require a taskId (the worker creates a branch and PR for the task).",
        400
      );
    }
    if (harness === "claude_cli") {
      void runClaudeCliImplement(
        run.id,
        input.taskId,
        input.baseBranch ?? "main",
        input.initialPrompt ?? null
      );
    } else {
      void runImplement(
        run.id,
        input.taskId,
        input.baseBranch ?? "main",
        input.initialPrompt ?? null
      );
    }
  }

  // Review-style runs: spin up a worktree at the PR's head ref and run a
  // single agent turn against it. Requires a prUrl on the run.
  if (!input.defer && cwdStrategy === "worktree_at_pr") {
    if (!input.prUrl) {
      throw new repo.RepoError(
        "cwd_strategy=worktree_at_pr requires a prUrl (the worktree is created from the PR's head ref).",
        400
      );
    }
    void runReview(run.id, input.prUrl, input.initialPrompt ?? null);
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

const TERMINAL_STATUS_LIST: SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "closed",
  "budget_exhausted",
];

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

  try {
    const run = get(input.runId);
    if (!run) {
      yield { type: "error", error: `Run ${input.runId} not found` };
      return;
    }
    if (isTerminalStatus(run.status) && run.status !== "idle") {
      yield {
        type: "error",
        error: `Run ${input.runId} is in terminal status '${run.status}'; cannot resume.`,
      };
      return;
    }
    if (run.status === "running" || run.status === "pushing" || run.status === "opening_pr") {
      // The lock guards against the in-process race; this guards against
      // a different process / a stale row inheriting status from before
      // this worker started.
      yield {
        type: "error",
        error: `Run ${input.runId} is already in flight (status=${run.status}).`,
      };
      return;
    }

    const userMsg = persistMessage(run.id, input.role === "system" ? "system" : "user", [
      { type: "text", text: input.text },
    ]);
    yield { type: "user_message", message: userMsg };

    setStatus(run.id, "running");

    // Re-materialize a missing worktree before invoking the SDK. Server
    // restarts and `git worktree prune` both kill the directory; the branch
    // on origin (and the local refs) survive, so we can recreate it.
    let cwd: string;
    try {
      cwd = await prepareCwd(run);
    } catch (err) {
      const msg = describe(err);
      setError(run.id, msg);
      yield { type: "error", error: msg };
      return;
    }

    const author = input.author ?? authorFor(run);
    const abort = input.abort ?? new AbortController();
    const bus = new EventEmitter();
    runners.set(run.id, { abort, bus });

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
      runners.delete(run.id);
      if (abort.signal.aborted) {
        // cancel() already updated the row.
        yield { type: "done" };
        return;
      }
      const msg = describe(err);
      setError(run.id, msg);
      yield { type: "error", error: msg };
      return;
    }

    runners.delete(run.id);

    // Forward streamed SDK envelopes to the caller. We accumulated them in
    // the turn helper rather than yielding live so the per-message persistence
    // and the SSE stream see the same sequence.
    for (const env of result.envelopes) {
      yield { type: "sdk", sdk: env };
    }

    // Stream end → idle (chat-style) unless we hit a budget cap.
    const budgetHit = checkBudget(run, result);
    const nextStatus: SessionStatus = budgetHit ? "budget_exhausted" : "idle";
    // Review-style runs surface a structured verdict in `outcome`. Gated on
    // goal so chat/implement append flows are unaffected.
    const outcomeUpdate =
      run.goal === "<review>"
        ? extractReviewOutcome(result.summary) ?? run.outcome
        : run.outcome;
    db.update(agentSessions)
      .set({
        status: nextStatus,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
        outcome: outcomeUpdate,
        completedAt: budgetHit ? new Date() : null,
      })
      .where(eq(agentSessions.id, run.id))
      .run();
    // Tell live SSE subscribers (the run-view in the browser) that the turn
    // ended. Without this, the client's React state stays at "running" even
    // though the DB row is idle, and the composer renders the queue hint
    // forever.
    emitStatus(run.id, nextStatus);

    yield { type: "done" };
  } finally {
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
  // Claude-CLI runs: a live runner's abort listener kills the tmux session,
  // but after a server restart there is no runner — kill it directly
  // (kill-session is idempotent, so doing both is harmless).
  if (run.harness === "claude_cli" && run.tmuxSession) {
    void killTmuxSession(run.tmuxSession);
  }
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, repoRoot(run)).catch(() => {});
  }
  return get(id)!;
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
  if (run.harness === "claude_cli" && run.tmuxSession) {
    void killTmuxSession(run.tmuxSession);
  }
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

function repoRoot(run: { repoId: string | null; taskId: string | null }): string {
  if (run.repoId) {
    const r = repo.getRepository(run.repoId);
    if (r?.localPath) return resolve(r.localPath);
  }
  if (run.taskId) {
    const r = repo.resolveRepoForTask(run.taskId);
    if (r?.localPath) return resolve(r.localPath);
  }
  const fallback = repo.defaultRepo();
  if (fallback?.localPath) return resolve(fallback.localPath);
  return ORCHESTRATOR_ROOT;
}

async function prepareCwd(run: RunRow): Promise<string> {
  if (run.cwdStrategy === "none") {
    return repoRoot(run);
  }
  if (run.cwdStrategy === "repo") {
    return repoRoot(run);
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
  }
  return run.worktreePath;
}

// ──────────────────────────────────────────────────────────
// Implement-style worker (initial turn → push → PR → idle)
// ──────────────────────────────────────────────────────────

async function runImplement(
  runId: number,
  taskId: string,
  baseBranch: string,
  initialPrompt: string | null
): Promise<void> {
  const abort = new AbortController();
  const bus = new EventEmitter();
  runners.set(runId, { abort, bus });

  let run = get(runId)!;
  let task = repo.getTask(taskId);
  if (!task) {
    fail(runId, `Task ${taskId} disappeared before run could start`);
    runners.delete(runId);
    return;
  }
  const root = repoRoot(run);
  const worktreeRoot = resolve(root, ".worktrees");
  const branch = `claude/${taskId.toLowerCase()}-${runId}`;
  const worktreePath = resolve(worktreeRoot, String(runId));

  try {
    setStatus(runId, "preparing");
    await mkdir(worktreeRoot, { recursive: true });
    await sh(["git", "worktree", "add", "-b", branch, worktreePath, baseBranch], root);
    db.update(agentSessions)
      .set({ branch, worktreePath, repoId: run.repoId ?? task.repoId ?? null })
      .where(eq(agentSessions.id, runId))
      .run();
    run = get(runId)!;

    if (task.state === "todo" || task.state === "blocked") {
      try {
        repo.transitionTask(taskId, {
          state: "in_progress",
          assignee: task.assignee ?? "claude-agent",
          note: `Started agent run #${runId}.`,
        });
      } catch {
        // Best-effort.
      }
    }

    setStatus(runId, "running");
    task = repo.getTask(taskId)!;
    // Caller-supplied prompt (from the modal preview) wins; otherwise
    // generate the canonical implement template from the task state.
    const prompt = initialPrompt ?? buildImplementPrompt(task);
    const author = "claude-agent";
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

    setStatus(runId, "pushing");
    await sh(["git", "push", "-u", "origin", branch], worktreePath);

    setStatus(runId, "opening_pr");
    const summary = result.summary;
    const prUrl = await openPr({ task, branch, baseBranch, worktreePath, summary });
    if (prUrl) {
      db.update(agentSessions).set({ prUrl }).where(eq(agentSessions.id, runId)).run();
    }

    try {
      repo.transitionTask(taskId, {
        state: "review",
        note: prUrl ? `Agent finished. PR: ${prUrl}` : `Agent finished. Branch: ${branch}`,
      });
    } catch (err) {
      repo.addNote(taskId, "claude-agent", `Could not transition to review: ${describe(err)}`);
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
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    fail(runId, describe(err));
    try {
      repo.transitionTask(taskId, {
        state: "blocked",
        note: `Agent run #${runId} failed: ${describe(err)}`,
      });
    } catch {
      // Ignore — task may not accept blocked from its current state.
    }
  } finally {
    closeBus(runId);
    runners.delete(runId);
    cleanupWorktree(worktreePath, root).catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────
// Claude CLI implement worker (worktree → claude in tmux → PR by branch)
// ──────────────────────────────────────────────────────────
//
// Mirrors runImplement, but the agent is Claude Code CLI inside tmux
// (lib/claude-cli.ts) and the operating contract is inverted: the agent
// commits, pushes, and opens the PR itself; we wait for its Stop hook and
// then find the PR by branch. Fallbacks: if it committed but skipped the
// gh step we push/open the PR ourselves; if it produced no commits at all
// we nudge once via tmux send-keys, then fail.

const CLI_NUDGE_TEXT =
  "Reminder: this run only counts when the work is committed and a PR exists. " +
  "Commit your changes, push with `git push -u origin HEAD`, and open a PR with `gh pr create`. " +
  "If you believe no code change is needed, say why in the PR body of an empty-change PR or commit a doc note.";

const CLI_NUDGE_WAIT_MS = 15 * 60 * 1000;

function cliTimeoutMs(run: RunRow): number {
  const envMs = parseInt(process.env.TASK_ORCH_CLAUDE_TIMEOUT_MS ?? "", 10);
  const base = Number.isFinite(envMs) && envMs > 0 ? envMs : 2 * 60 * 60 * 1000;
  if (run.budgetMaxSeconds != null && run.budgetMaxSeconds > 0) {
    return Math.min(base, run.budgetMaxSeconds * 1000);
  }
  return base;
}

/** Origin the Claude Code hooks curl back to. */
function hookBaseUrl(): string {
  return (
    process.env.TASK_ORCH_BASE_URL ??
    process.env.NEXTAUTH_URL ??
    `http://localhost:${process.env.PORT ?? 3000}`
  );
}

/**
 * Durable + live system note on a run's timeline. Persists the shape the
 * run view's extractSystemMeta expects ([{type:<kind>, …payload}], plus a
 * text block so SystemEventRow renders prose instead of JSON) and emits a
 * `system` bus event for connected SSE clients.
 */
function systemNote(runId: number, kind: "info" | "warning", text: string) {
  try {
    persistMessage(runId, "system", [
      { type: kind, message: text } as any,
      { type: "text", text } as any,
    ]);
  } catch {
    // best-effort
  }
  emitRunEvent(runId, "system", { kind, text });
}

async function findPrByBranch(branch: string, cwd: string): Promise<string | null> {
  try {
    const out = await sh(
      ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url"],
      cwd
    );
    const url = out.trim();
    return url.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}

async function countCommitsAhead(baseBranch: string, cwd: string): Promise<number> {
  try {
    const out = await sh(["git", "rev-list", "--count", `${baseBranch}..HEAD`], cwd);
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function cliDoneError(done: ClaudeCliDone): string {
  switch (done.kind) {
    case "exited":
      return (
        `Claude Code exited (code ${done.exitCode}) before finishing the task.` +
        (done.paneTail ? `\n\nLast terminal output:\n${done.paneTail}` : "")
      );
    case "killed":
      return "The tmux session for this run disappeared (killed externally?).";
    case "timeout":
      return "Claude Code run timed out.";
    default:
      return "Claude Code run ended unexpectedly.";
  }
}

async function runClaudeCliImplement(
  runId: number,
  taskId: string,
  baseBranch: string,
  initialPrompt: string | null
): Promise<void> {
  const abort = new AbortController();
  const bus = new EventEmitter();
  runners.set(runId, { abort, bus });

  let run = get(runId)!;
  let task = repo.getTask(taskId);
  if (!task) {
    fail(runId, `Task ${taskId} disappeared before run could start`);
    runners.delete(runId);
    return;
  }
  const root = repoRoot(run);
  const worktreeRoot = resolve(root, ".worktrees");
  const branch = `claude/${taskId.toLowerCase()}-${runId}`;
  const worktreePath = resolve(worktreeRoot, String(runId));

  let handle: ClaudeCliHandle | null = null;
  try {
    // Fail fast before touching git if tmux/claude aren't usable.
    const unavailable = await checkClaudeCliAvailable();
    if (unavailable) throw new Error(unavailable);

    setStatus(runId, "preparing");
    await mkdir(worktreeRoot, { recursive: true });
    await sh(["git", "worktree", "add", "-b", branch, worktreePath, baseBranch], root);

    const claudeSessionId = randomUUID();
    const hookToken = randomBytes(24).toString("hex");
    const tmuxSession = tmuxSessionName(runId);
    db.update(agentSessions)
      .set({
        branch,
        worktreePath,
        repoId: run.repoId ?? task.repoId ?? null,
        // Claude's session UUID doubles as the harness-side session id
        // (the pi path stores its session file path here).
        sdkSessionId: claudeSessionId,
        hookToken,
        tmuxSession,
      })
      .where(eq(agentSessions.id, runId))
      .run();
    run = get(runId)!;

    if (task.state === "todo" || task.state === "blocked") {
      try {
        repo.transitionTask(taskId, {
          state: "in_progress",
          assignee: task.assignee ?? "claude-agent",
          note: `Started Claude CLI agent run #${runId}.`,
        });
      } catch {
        // Best-effort.
      }
    }

    setStatus(runId, "running");
    task = repo.getTask(taskId)!;
    const prompt = initialPrompt ?? buildCliImplementPrompt(task, { baseBranch });

    handle = await startClaudeCli({
      runId,
      cwd: worktreePath,
      prompt,
      claudeSessionId,
      hookToken,
      baseUrl: hookBaseUrl(),
      timeoutMs: cliTimeoutMs(run),
      onEnvelope: (env) => {
        bus.emit("event", { type: "sdk", sdk: env });
        if (env.type === "assistant" && env.message.content.length > 0) {
          persistMessage(runId, "agent", env.message.content as any);
        } else if (env.type === "user") {
          const blocks = env.message.content;
          const toolResults = blocks.filter((b: any) => b.type === "tool_result");
          if (toolResults.length > 0) {
            persistMessage(runId, "tool", toolResults as any);
          } else if (blocks.length > 0) {
            // A human attached to the tmux session and typed something.
            persistMessage(runId, "user", blocks as any);
          }
        }
      },
      onSystem: (kind, payload) => {
        systemNote(runId, kind, String(payload.text ?? JSON.stringify(payload)));
      },
    });
    abort.signal.addEventListener("abort", () => {
      void handle?.cancel();
    });

    systemNote(
      runId,
      "info",
      `Claude Code is running in tmux — watch or steer with: ${handle.attachHint}`
    );

    let done = await handle.done;
    let prUrl: string | null = null;
    let nudged = false;
    for (;;) {
      if (abort.signal.aborted) {
        runners.delete(runId);
        return;
      }
      if (done.kind !== "stop") throw new Error(cliDoneError(done));

      setStatus(runId, "opening_pr");
      prUrl = await findPrByBranch(branch, worktreePath);
      if (prUrl) break;

      const commits = await countCommitsAhead(baseBranch, worktreePath);
      if (commits > 0) {
        // The agent committed but skipped push and/or `gh pr create` —
        // fall back to the orchestrator handoff used by the pi path.
        setStatus(runId, "pushing");
        await sh(["git", "push", "-u", "origin", branch], worktreePath);
        setStatus(runId, "opening_pr");
        prUrl = await openPr({ task, branch, baseBranch, worktreePath, summary: null });
        break;
      }

      if (nudged) {
        throw new Error("Claude Code finished without making any commits.");
      }
      nudged = true;
      systemNote(
        runId,
        "warning",
        "Agent stopped without committing anything — sending a one-time reminder."
      );
      setStatus(runId, "running");
      done = await handle.nudge(CLI_NUDGE_TEXT, CLI_NUDGE_WAIT_MS);
    }

    if (prUrl) {
      db.update(agentSessions).set({ prUrl }).where(eq(agentSessions.id, runId)).run();
    }

    try {
      repo.transitionTask(taskId, {
        state: "review",
        note: prUrl ? `Agent finished. PR: ${prUrl}` : `Agent finished. Branch: ${branch}`,
      });
    } catch (err) {
      repo.addNote(taskId, "claude-agent", `Could not transition to review: ${describe(err)}`);
    }

    db.update(agentSessions)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(agentSessions.id, runId))
      .run();
    emitStatus(runId, "completed");
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    fail(runId, describe(err));
    try {
      repo.transitionTask(taskId, {
        state: "blocked",
        note: `Agent run #${runId} failed: ${describe(err)}`,
      });
    } catch {
      // Ignore — task may not accept blocked from its current state.
    }
  } finally {
    closeBus(runId);
    runners.delete(runId);
    await handle?.cancel().catch(() => {});
    cleanupWorktree(worktreePath, root).catch(() => {});
  }
}

/**
 * Entry point for /api/runs/:id/hook — feed a Claude Code lifecycle hook
 * callback to the run. SessionStart also persists the transcript path the
 * tailer needs (and a future reattach could resume from). Must return
 * fast: the worker, not the caller, performs the PR/completion flow.
 */
export function handleClaudeHook(runId: number, payload: Record<string, unknown>): void {
  const event = payload.hook_event_name;
  if (event !== "SessionStart" && event !== "Stop" && event !== "SessionEnd") return;

  if (event === "SessionStart") {
    const transcriptPath = payload.transcript_path;
    if (typeof transcriptPath === "string" && transcriptPath) {
      db.update(agentSessions)
        .set({ transcriptPath })
        .where(eq(agentSessions.id, runId))
        .run();
    }
  }
  getClaudeCliHandle(runId)?.hook(event as ClaudeHookEvent, payload);
}

/**
 * Targeted read for the hook route's bearer-token check. hookToken is
 * deliberately not part of RunRow (it would leak into page props).
 */
export function getHookAuth(
  runId: number
): { hookToken: string | null; status: SessionStatus; harness: Harness } | null {
  const row = db
    .select({
      hookToken: agentSessions.hookToken,
      status: agentSessions.status,
      harness: agentSessions.harness,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, runId))
    .get();
  if (!row) return null;
  return {
    hookToken: row.hookToken,
    status: row.status as SessionStatus,
    harness: (row.harness as Harness) ?? "pi",
  };
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

  let run = get(runId)!;
  const root = repoRoot(run);
  const worktreeRoot = resolve(root, ".worktrees");
  const branch = `review-${runId}`;
  const worktreePath = resolve(worktreeRoot, `review-${runId}`);

  try {
    const parsed = parsePrUrl(prUrl);
    if (!parsed) {
      fail(runId, `Could not parse PR url: ${prUrl}`);
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
      fail(
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
  } catch (err) {
    if (abort.signal.aborted) {
      runners.delete(runId);
      return;
    }
    fail(runId, describe(err));
  } finally {
    closeBus(runId);
    runners.delete(runId);
    cleanupWorktree(worktreePath, root).catch(() => {});
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

  const modelId = run.model ?? persona.modelId;
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
    model: { provider: persona.modelProvider, id: persona.modelId },
    thinkingLevel: (persona.thinkingLevel ?? undefined) as "low" | "medium" | "high" | undefined,
    toolsProfile: persona.toolsProfile,
    skillPaths: [] as string[],
  };

  const factories = [
    personaPromptFactory(personaForExt),
    personaMemoryFactory(personaForExt, run, repo, cwd),
    sandboxFactory(cwd, sandboxDbPath),
    abortBridgeFactory(abort),
    ...profileFactories,
  ];

  const sessionDir = path.join(cwd, ".pi", "sessions");
  const sessionManager = run.sdkSessionId
    ? SessionManager.open(run.sdkSessionId, sessionDir)
    : SessionManager.create(cwd, sessionDir);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const agentDir = getAgentDir();
  // Skills come from pi's default discovery: <cwd>/.pi/skills/, .agents/skills/
  // (cwd + ancestors), ~/.pi/agent/skills/, ~/.agents/skills/. We don't add
  // persona-specific paths anymore; skills belong to the project, not the role.
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: factories,
  });

  const { session } = await createAgentSession({
    cwd,
    model: getModel(persona.modelProvider as any, modelId as any),
    thinkingLevel: (persona.thinkingLevel ?? undefined) as any,
    authStorage,
    modelRegistry,
    sessionManager,
    resourceLoader,
  });

  const envelopes: RunEnvelope[] = [];
  const assistantBlocks: any[] = [];
  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let turns = 0;

  const stop = session.subscribe((rawEv: any) => {
    if (abort.signal.aborted) return;

    if (rawEv.type === "turn_end") turns += 1;

    for (const env of mapPiEvent(rawEv, session, sessionManager)) {
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
        for (const b of env.message.content) assistantBlocks.push(b);
        const text = env.message.content
          .filter((b: any) => b.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n").trim();
        if (text) lastAssistantText = text;
      }

      if (env.type === "user" && env.message?.content) {
        const toolResults = env.message.content.filter((b: any) => b.type === "tool_result");
        if (toolResults.length > 0) persistMessage(run.id, "tool", toolResults as any);
      }

      if (env.type === "result") {
        if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
        inputTokens = env.usage?.input_tokens ?? inputTokens;
        outputTokens = env.usage?.output_tokens ?? outputTokens;
      }
    }
  });

  try {
    await session.prompt(prompt);  // resolves after agent_end settles
  } finally {
    stop();
  }

  if (assistantBlocks.length > 0) {
    persistMessage(run.id, "agent", assistantBlocks as any);
  }

  return {
    envelopes: envelopes as any,
    summary: summary ?? lastAssistantText,
    sdkSessionId,
    totalCostUsd: null,
    inputTokens,
    outputTokens,
    turns,
  };
}

function checkBudget(run: RunRow, result: TurnResult): boolean {
  if (run.budgetMaxTurns != null && result.turns >= run.budgetMaxTurns) return true;
  // budgetMaxUsd not enforced under pi (no total_cost_usd surface);
  // column kept for historical data (see SCHEMA.md).
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

function setError(runId: number, error: string) {
  db.update(agentSessions)
    .set({ status: "failed", error, completedAt: new Date() })
    .where(eq(agentSessions.id, runId))
    .run();
  emitStatus(runId, "failed", { error });
}

function fail(runId: number, error: string) {
  setError(runId, error);
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
    harness: (row.harness as Harness) ?? "pi",
    tmuxSession: row.tmuxSession,
    transcriptPath: row.transcriptPath,
    model: row.model,
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
    startedAt: row.startedAt,
    completedAt: row.completedAt,
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
// Predicates used by lib/chat.ts and lib/agent.ts shims
// ──────────────────────────────────────────────────────────

export function chatRunPredicate() {
  return or(eq(agentSessions.goal, "<chat>"), isNotNull(agentSessions.legacyChatId));
}

export function implementRunPredicate() {
  return and(isNotNull(agentSessions.taskId), eq(agentSessions.goal, "<implement>"));
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

export function listRuns(filters: RunFilters = {}): RunRow[] {
  const wheres = [];
  if (filters.repoId) wheres.push(eq(agentSessions.repoId, filters.repoId));
  if (filters.taskId) wheres.push(eq(agentSessions.taskId, filters.taskId));
  if (filters.planId) wheres.push(eq(agentSessions.planId, filters.planId));
  const where = wheres.length === 0 ? undefined : wheres.length === 1 ? wheres[0] : and(...wheres);
  const rows = db
    .select()
    .from(agentSessions)
    .where(where)
    .orderBy(desc(agentSessions.startedAt))
    .all();
  return rows.map(hydrateRun);
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
  if (run.cwdStrategy === "worktree") {
    return resolve(cwd, ".task-orch-sandbox.db");
  }
  return join(tmpdir(), `task-orch-run-${run.id}.sandbox.db`);
}

function sanitizeEnv(
  input: NodeJS.ProcessEnv,
  opts: { sandboxDbPath: string }
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_") ||
      k.startsWith("CLAUDE_SESSION_") ||
      k.startsWith("CLAUDE_ENABLE_") ||
      k.startsWith("CLAUDE_AFTER_") ||
      k.startsWith("CLAUDE_AUTO_") ||
      k === "TASK_ORCH_DB" ||
      k === "AUTH_SECRET"
    ) {
      continue;
    }
    out[k] = v;
  }
  out.TASK_ORCH_DB = opts.sandboxDbPath;
  return out;
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

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
