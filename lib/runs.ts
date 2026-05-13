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
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentMessages, agentSessions } from "@/db/schema";
import * as repo from "./repo";
import type { SdkContentBlock, SdkMessageEnvelope } from "./sdk-message";
import type { AgentSessionFull, SessionStatus } from "./types";
import { isTerminalStatus } from "./types";

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

export type Goal = "<implement>" | "<chat>" | (string & {});
export type CwdStrategy = "worktree" | "repo" | "none";

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
  prUrl?: string | null;
  parentRunId?: number | null;
  model?: string | null;
  budget?: Budget | null;
  userId?: number | null;
  title?: string | null;
  /** For implement-style runs: the base branch the worktree branches from. */
  baseBranch?: string;
  /** Optional initial agent prompt; if omitted the run waits for runs.append. */
  initialPrompt?: string | null;
  /** If true, do NOT kick off the worker on create; useful for chats. */
  defer?: boolean;
}

export interface RunRow {
  id: number;
  goal: string;
  status: SessionStatus;
  taskId: string | null;
  repoId: string | null;
  parentRunId: number | null;
  toolsProfile: string;
  cwdStrategy: CwdStrategy;
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
  sdk?: SdkMessageEnvelope;
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
// Tool profile registry
// ──────────────────────────────────────────────────────────
//
// A profile is a string key that resolves to one or more named MCP servers.
// `toolsProfile` on a run is a comma-separated list of profile keys; the
// runner unions all servers from the listed profiles into the `mcpServers`
// map handed to sdk.query().
//
// `orchestrator` mounts the task-orchestrator MCP surface (plans, tasks,
// notes, criteria, sessions). `repo_write` and `repo_read` are markers for
// what the SDK should be allowed to do in the cwd: there's no separate MCP
// server today (the SDK's built-in Bash/Edit/Read tools handle this), but
// the profile string drives sandbox + permission-mode wiring. `gh_pr` mounts
// the GitHub PR helper server (open/list/comment).

export type McpServerFactory = (ctx: ProfileContext) => unknown | Promise<unknown>;

export interface ProfileContext {
  runId: number;
  run: RunRow;
  /** Author label for any orchestrator-side mutations the agent makes. */
  author: string;
  /** Optional taskId scoping for the orchestrator MCP server. */
  taskId: string | null;
}

interface ProfileDef {
  /** MCP servers this profile contributes; map key is the SDK mcpServers key. */
  servers: Record<string, McpServerFactory>;
  /** Permission posture this profile imposes on the SDK call. */
  allowsRepoWrite?: boolean;
}

const PROFILES: Record<string, ProfileDef> = {
  orchestrator: {
    servers: {
      task_orch: async (ctx) => {
        const { createOrchestratorMcpServer } = await import("./agent-mcp");
        return createOrchestratorMcpServer({
          author: ctx.author,
          defaultTaskId: ctx.taskId ?? undefined,
        });
      },
    },
  },
  repo_write: {
    // No MCP server: the SDK's built-in Bash/Edit/Write tools handle file
    // writes. Profile presence flips allowsRepoWrite which is consumed by
    // future permission gating.
    servers: {},
    allowsRepoWrite: true,
  },
  repo_read: {
    // Same shape as repo_write minus mutation. Today both rely on
    // permissionMode='bypassPermissions' inside the sandbox; the profile
    // string is the source of truth so a future tightening can switch on it.
    servers: {},
    allowsRepoWrite: false,
  },
  gh_pr: {
    servers: {
      gh_pr: async () => {
        const { createGhPrMcpServer } = await import("./gh-pr-mcp");
        return createGhPrMcpServer();
      },
    },
  },
};

interface ResolvedProfile {
  servers: Record<string, unknown>;
  allowsRepoWrite: boolean;
}

async function resolveProfiles(profileString: string, ctx: ProfileContext): Promise<ResolvedProfile> {
  const names = profileString
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const servers: Record<string, unknown> = {};
  let allowsRepoWrite = false;
  for (const name of names) {
    const def = PROFILES[name];
    if (!def) {
      // Unknown profile: log but don't crash. New profiles ship via code; an
      // old DB row may reference one we no longer recognise.
      console.warn(`[runs] unknown tool profile '${name}' on run #${ctx.runId}`);
      continue;
    }
    if (def.allowsRepoWrite) allowsRepoWrite = true;
    for (const [key, factory] of Object.entries(def.servers)) {
      servers[key] = await factory(ctx);
    }
  }
  return { servers, allowsRepoWrite };
}

// ──────────────────────────────────────────────────────────
// CRUD: create / list / get
// ──────────────────────────────────────────────────────────

export function create(input: CreateRunInput): RunRow {
  const goal = input.goal ?? "<chat>";
  const cwdStrategy: CwdStrategy = input.cwdStrategy ?? (goal === "<chat>" ? "none" : "worktree");
  const toolsProfile =
    input.toolsProfile ?? (goal === "<chat>" ? "orchestrator,repo_write" : "orchestrator,repo_write");
  const initialStatus: SessionStatus = input.defer || goal === "<chat>" ? "idle" : "pending";

  // Resolve repo: explicit > task's repo > defaultRepo. We don't error on
  // missing repo at create time for chat-style runs; the cwd resolver falls
  // back to the orchestrator checkout.
  let repoId: string | null = input.repoId ?? null;
  if (!repoId && input.taskId) {
    const t = repo.getTask(input.taskId);
    if (t?.repoId) repoId = t.repoId;
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

  const inserted = db
    .insert(agentSessions)
    .values({
      goal,
      taskId: input.taskId ?? null,
      repoId,
      parentRunId: input.parentRunId ?? null,
      toolsProfile,
      cwdStrategy,
      model: input.model ?? DEFAULT_MODEL,
      title: input.title ?? null,
      userId: input.userId ?? null,
      prUrl: input.prUrl ?? null,
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
    void runImplement(run.id, input.taskId, input.baseBranch ?? "main");
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
    db.update(agentSessions)
      .set({
        status: nextStatus,
        sdkSessionId: result.sdkSessionId ?? run.sdkSessionId,
        totalCostUsd: result.totalCostUsd ?? run.totalCostUsd,
        inputTokens: result.inputTokens ?? run.inputTokens,
        outputTokens: result.outputTokens ?? run.outputTokens,
        completedAt: budgetHit ? new Date() : null,
      })
      .where(eq(agentSessions.id, run.id))
      .run();

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
  if (run.cwdStrategy === "worktree" && run.worktreePath) {
    cleanupWorktree(run.worktreePath, repoRoot(run)).catch(() => {});
  }
  return get(id)!;
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
  // worktree: re-materialize if missing.
  if (!run.branch || !run.worktreePath) {
    throw new Error(
      `Run #${run.id} has cwd_strategy=worktree but no branch/worktree_path recorded yet.`
    );
  }
  const root = repoRoot(run);
  if (!existsSync(run.worktreePath)) {
    await mkdir(dirname(run.worktreePath), { recursive: true });
    // The branch already exists on the remote (it was pushed by the initial
    // implement turn), so a plain `git worktree add <path> <branch>` is
    // sufficient — git checks out the existing branch into the new path.
    await sh(["git", "worktree", "add", run.worktreePath, run.branch], root);
  }
  return run.worktreePath;
}

// ──────────────────────────────────────────────────────────
// Implement-style worker (initial turn → push → PR → idle)
// ──────────────────────────────────────────────────────────

async function runImplement(runId: number, taskId: string, baseBranch: string): Promise<void> {
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
    const prompt = buildImplementPrompt(task);
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

function buildImplementPrompt(task: NonNullable<ReturnType<typeof repo.getTask>>): string {
  const lines: string[] = [];
  lines.push(`You are an autonomous coding agent working on task ${task.id}.`);
  lines.push("");
  lines.push(`# ${task.title}`);
  if (task.body.trim()) {
    lines.push("");
    lines.push("## Description");
    lines.push(task.body.trim());
  }
  if (task.criteria.length > 0) {
    lines.push("");
    lines.push("## Acceptance criteria");
    for (const c of task.criteria) lines.push(`- [${c.done ? "x" : " "}] ${c.text}`);
  }
  if (task.dependencies.length > 0) {
    lines.push("");
    lines.push("## Depends on (already done)");
    for (const dep of task.dependencies) lines.push(`- ${dep}`);
  }
  lines.push("");
  lines.push("# Working environment");
  lines.push("- You are in an isolated git worktree on a fresh branch.");
  lines.push("- Make all changes here. Commit with a clear message.");
  lines.push("- Do NOT push and do NOT open a PR — the orchestrator does both after you finish.");
  lines.push("- Run typecheck and lint where it applies; fix any errors you introduce.");
  lines.push("- This is a non-interactive run. Make reasonable decisions; do not ask questions.");
  lines.push("");
  lines.push("# Task-system MCP tools");
  lines.push("- mcp__task_orch__add_note(body): log a decision so the next person can see why.");
  lines.push("- mcp__task_orch__check_criterion(criterion): mark an acceptance criterion done.");
  lines.push("- mcp__task_orch__uncheck_criterion(criterion): undo if you check the wrong one.");
  lines.push("- mcp__task_orch__add_criterion(text): add a criterion you discovered along the way.");
  lines.push("- mcp__task_orch__list_criteria(): see the current state of criteria.");
  lines.push("Use these as you work — don't batch them until the end. Match criteria by substring.");
  lines.push("");
  lines.push("# Finishing");
  lines.push("- Commit, then stop. Do NOT push, do NOT open the PR — the orchestrator does both.");
  lines.push("- Your final assistant message becomes the PR description. Write a clean summary:");
  lines.push("  - 1-3 sentences explaining what you did and why");
  lines.push("  - bullet list of the main files / behaviours that changed if non-trivial");
  lines.push("  - call out any caveats, follow-ups, or skipped acceptance criteria");
  return lines.join("\n");
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
  onSdk?: (m: SdkMessageEnvelope) => void;
}

interface TurnResult {
  envelopes: SdkMessageEnvelope[];
  summary: string | null;
  sdkSessionId: string | null;
  totalCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  turns: number;
}

async function runOneTurn(args: RunOneTurnArgs): Promise<TurnResult> {
  const { run, cwd, prompt, abort, author, onSdk } = args;

  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (input: { prompt: string; options?: any }) => AsyncIterable<unknown>;
  };

  const profileCtx: ProfileContext = {
    runId: run.id,
    run,
    author,
    taskId: run.taskId,
  };
  const { servers } = await resolveProfiles(run.toolsProfile, profileCtx);

  const sandboxDbPath = sandboxDbPathFor(run, cwd);
  const env = sanitizeEnv(process.env, { sandboxDbPath });

  const stream = sdk.query({
    prompt,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      model: run.model ?? DEFAULT_MODEL,
      env,
      abortController: abort,
      stderr: (data: string) => {
        // Surface SDK stderr to console; consumers reading the bus get
        // a stderr envelope too.
        console.error(`[run ${run.id}] sdk stderr:`, data.trimEnd());
      },
      systemPrompt: { type: "preset", preset: "claude_code" },
      mcpServers: servers,
      resume: run.sdkSessionId ?? undefined,
      sandbox: SANDBOX_OPTS,
    },
  });

  const envelopes: SdkMessageEnvelope[] = [];
  const assistantBlocks: SdkContentBlock[] = [];
  let summary: string | null = null;
  let lastAssistantText: string | null = null;
  let sdkSessionId: string | null = null;
  let totalCostUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let turns = 0;

  for await (const raw of stream) {
    if (abort.signal.aborted) break;
    const m = raw as SdkMessageEnvelope;
    envelopes.push(m);
    onSdk?.(m);

    if (m.type === "system" && m.subtype === "init" && m.session_id) {
      sdkSessionId = m.session_id;
      // Persist immediately so a crash mid-turn still leaves us a resume id.
      db.update(agentSessions)
        .set({ sdkSessionId })
        .where(eq(agentSessions.id, run.id))
        .run();
    }

    if (m.type === "assistant" && m.message?.content) {
      for (const b of m.message.content) assistantBlocks.push(b);
      const text = m.message.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n")
        .trim();
      if (text) lastAssistantText = text;
      turns += 1;
    }

    if (m.type === "user" && m.message?.content) {
      const toolResults = m.message.content.filter((b) => b.type === "tool_result");
      if (toolResults.length > 0) {
        persistMessage(run.id, "tool", toolResults);
      }
    }

    if (m.type === "result") {
      if (!m.is_error && typeof m.result === "string") summary = m.result.trim() || null;
      totalCostUsd = m.total_cost_usd ?? totalCostUsd;
      inputTokens = m.usage?.input_tokens ?? inputTokens;
      outputTokens = m.usage?.output_tokens ?? outputTokens;
    }
  }

  if (assistantBlocks.length > 0) {
    persistMessage(run.id, "agent", assistantBlocks);
  }

  return {
    envelopes,
    summary: summary ?? lastAssistantText,
    sdkSessionId,
    totalCostUsd,
    inputTokens,
    outputTokens,
    turns,
  };
}

function checkBudget(run: RunRow, result: TurnResult): boolean {
  if (run.budgetMaxTurns != null && result.turns >= run.budgetMaxTurns) return true;
  if (run.budgetMaxUsd != null && (result.totalCostUsd ?? 0) >= run.budgetMaxUsd) return true;
  // maxSeconds is best enforced at turn-start vs an alarm; left for later.
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

// ──────────────────────────────────────────────────────────
// Hydration
// ──────────────────────────────────────────────────────────

function hydrateRun(row: typeof agentSessions.$inferSelect): RunRow {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status as SessionStatus,
    taskId: row.taskId,
    repoId: row.repoId,
    parentRunId: row.parentRunId,
    toolsProfile: row.toolsProfile,
    cwdStrategy: row.cwdStrategy as CwdStrategy,
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
// Misc helpers
// ──────────────────────────────────────────────────────────

function authorFor(run: RunRow): string {
  if (run.goal === "<chat>") return "chat";
  return "claude-agent";
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
