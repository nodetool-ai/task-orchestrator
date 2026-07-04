// Task-agent shim around lib/runs.ts.
//
// Historically this file owned the worktree → SDK → push → PR worker. As of
// T-20260513-0048 that lifecycle lives in lib/runs.ts; this module is a thin
// adapter that preserves the existing AgentSessionFull-shaped API used by
// /api/sessions/*, /api/tasks/[id]/sessions, the /sessions UI pages, and
// cli.ts. New callers should import lib/runs.ts directly.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions, tasks } from "@/db/schema";
import * as repo from "./repo";
import * as runs from "./runs";
import {
  isTerminalStatus,
  type AgentEventRow,
  type AgentSessionFull,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "claude-sonnet-4-6";

// ──────────────────────────────────────────────────────────
// Background tasks (orphan reaper, PR-merge poller).
//
// These need to run regardless of whether anyone imports lib/runs.ts, so
// they live here on the legacy module that every API route already touches.
// ──────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __agentReaperRan: boolean | undefined;
  // eslint-disable-next-line no-var
  var __agentPrWatcher: NodeJS.Timeout | undefined;
}

// Declared before the module-init reaper invocation below. reapOrphans() is a
// hoisted function, but this `const` is not: with the declaration placed after
// the invocation, reapOrphans' `.filter(... NON_TERMINAL_BUT_DEAD.includes ...)`
// reads it in the temporal dead zone whenever the boot DB actually has an
// implement run to filter — a TDZ ReferenceError swallowed as "reaper failed"
// (empty test DBs never enter the filter callback, so the suite stayed green).
const NON_TERMINAL_BUT_DEAD = ["pending", "preparing", "running", "pushing", "opening_pr"];

// Grace period for pending rows before treating as orphaned. Fresh pending rows
// are the dispatch queue — owned by the creating process's kickoff or the
// detached pump in lib/run-dispatch.ts. Only an old one indicates the owning
// process died before dispatch.
const PENDING_GRACE_PERIOD_MS = 15 * 60_000; // 15 minutes

if (!globalThis.__agentReaperRan) {
  globalThis.__agentReaperRan = true;
  reapOrphans().catch((err) => {
    console.error("agent: reaper failed:", err);
  });
}

const PR_POLL_MS = Number(process.env.TASK_ORCH_PR_POLL_MS ?? 60_000);
if (!globalThis.__agentPrWatcher && PR_POLL_MS > 0) {
  globalThis.__agentPrWatcher = setInterval(() => {
    pollMergedPrs().catch((err) => console.error("agent: pr watcher failed:", err));
  }, PR_POLL_MS);
  globalThis.__agentPrWatcher.unref?.();
}

async function reapOrphans() {
  // Implement-style runs in any in-flight status are suspect after a restart.
  // Idle/closed/budget_exhausted/completed/failed/cancelled rows are left alone.
  const now = new Date();
  const orphans = (
    await db
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.goal, "<implement>"),
          isNotNull(agentSessions.taskId)
        )
      )
  ).filter((row) => {
    if (!NON_TERMINAL_BUT_DEAD.includes(row.status)) return false;
    // pending rows are fresh dispatch-queue entries; only reap if genuinely stale
    if (row.status === "pending") {
      return now.getTime() - row.startedAt.getTime() > PENDING_GRACE_PERIOD_MS;
    }
    return true;
  });

  for (const orphan of orphans) {
    // Never reap a run that is genuinely in flight:
    //   • runs.isLive → an in-process runner exists here.
    //   • runs.isLeaseLive → an active status with a FRESH heartbeat, i.e. a
    //     turn running in ANOTHER process (this reaper fires on every module
    //     import — Next server boot, but also short-lived cli.ts / pipe
    //     processes that share the SQLite DB).
    // Without the lease check, a CLI invocation while the Next server has an
    // implement run mid-turn would flip it to `failed` AND `git worktree remove
    // --force` the worktree the live agent is editing, destroying its work.
    // Mirror runs.reconcileOrphanedRuns(), which uses the same lease guard.
    if (runs.isLive(orphan.id)) continue;
    if (runs.isLeaseLive(orphan)) continue;
    const now = new Date();
    await db.update(agentSessions)
      .set({
        status: "failed",
        error: orphan.error ?? "Orphaned by server restart",
        completedAt: now,
      })
      .where(eq(agentSessions.id, orphan.id));
    await db.insert(agentEvents)
      .values({
        sessionId: orphan.id,
        type: "status",
        payload: JSON.stringify({ status: "failed", error: "Orphaned by server restart" }),
        createdAt: now,
      });
    if (orphan.worktreePath && orphan.taskId) {
      const root = await repoRootForSession(orphan.taskId);
      cleanupWorktree(orphan.worktreePath, root).catch(() => {});
    }
  }
}

async function pollMergedPrs(): Promise<void> {
  const rows = await db
    .select({
      sessionId: agentSessions.id,
      taskId: agentSessions.taskId,
      prUrl: agentSessions.prUrl,
      startedAt: agentSessions.startedAt,
    })
    .from(agentSessions)
    .innerJoin(tasks, eq(tasks.id, agentSessions.taskId))
    // `review` is the happy path; `in_progress` catches tasks whose
    // review-transition failed or whose PR a human merged early. Both states
    // can transition directly to `done`.
    .where(and(isNotNull(agentSessions.prUrl), inArray(tasks.state, ["in_progress", "review"])));

  // Group every PR-bearing run by task. A task can have more than one run with
  // a PR (e.g. a stale run plus a follow-up that opened a different PR), and the
  // *merged* one isn't necessarily the newest — collapsing to the latest run
  // per task would miss it and strand the task open.
  const byTask = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    if (!r.taskId || !r.prUrl) continue;
    const list = byTask.get(r.taskId);
    if (list) list.push(r);
    else byTask.set(r.taskId, [r]);
  }

  for (const [taskId, taskRows] of byTask) {
    // Newest-first so a freshly merged PR is found quickly, but still fall
    // through to older PR-bearing runs.
    taskRows.sort((a, b) => (a.startedAt > b.startedAt ? -1 : 1));
    for (const r of taskRows) {
      if (!r.prUrl) continue;
      const info = await ghPrState(r.prUrl);
      if (!info || info.state !== "MERGED") continue;
      try {
        await repo.transitionTask(taskId, {
          state: "done",
          note: `PR merged: ${r.prUrl}`,
          // A merged PR is authoritative — close the task even if acceptance
          // criteria were never checked off, rather than stranding it open.
          bypassCriteria: true,
        });
        await db.insert(agentEvents)
          .values({
            sessionId: r.sessionId,
            type: "pr_merged",
            payload: JSON.stringify({ url: r.prUrl, mergedAt: info.mergedAt }),
            createdAt: new Date(),
          });
      } catch (err) {
        try {
          await repo.addNote(
            taskId,
            "claude-agent",
            `PR merged but could not transition to done: ${describe(err)}`
          );
        } catch {
          // ignore
        }
      }
      // The task is resolved (or we recorded why it couldn't be); stop checking
      // its remaining PRs.
      break;
    }
  }
}

interface PrState {
  state: string;
  mergedAt: string | null;
}

function ghPrState(prUrl: string): Promise<PrState | null> {
  return new Promise((resolveP) => {
    const child = spawn("gh", ["pr", "view", prUrl, "--json", "state,mergedAt"], {
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolveP(null));
    child.on("close", (code) => {
      if (code !== 0) {
        if (stderr) console.warn("gh pr view failed:", stderr.trim());
        resolveP(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as PrState;
        resolveP(parsed);
      } catch {
        resolveP(null);
      }
    });
  });
}

// ──────────────────────────────────────────────────────────
// Public API (legacy shape; delegates to lib/runs.ts)
// ──────────────────────────────────────────────────────────

export interface StartSessionInput {
  taskId: string;
  model?: string;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh" | null;
  baseBranch?: string;
  resumeOf?: number;
  /** Lineage parent (e.g. the plan executor that spawned this). Used for UI
   *  grouping and the tree budget cap. `resumeOf` takes precedence. */
  parentRunId?: number | null;
  /** User the session is attributed to; spawned children inherit the
   *  spawner's userId so attribution survives across the run tree. */
  userId?: number | null;
}

export async function startSession(input: StartSessionInput): Promise<AgentSessionFull> {
  const task = await repo.getTask(input.taskId);
  if (!task) throw new repo.RepoError(`Task ${input.taskId} not found`, 404);

  // M17c: listActiveSessions(taskId) followed eventually by runs.create() used
  // to be a plain check-then-insert with several awaits in between (resumeOf
  // validation, runs.create's own internal queries) — two concurrent
  // start_session calls for the same task could both observe zero active
  // sessions and both go on to create a run, leaving two competing
  // worktrees/PRs implementing the same task.
  //
  // runs.create is owned by lib/runs.ts (out of scope for this fix) and
  // inserts via the module-level `db`, not a transaction we control here, so
  // we can't take a row lock on the run it's about to insert. Instead we take
  // a Postgres *transaction-scoped advisory lock* keyed on the task id around
  // the whole check-then-create critical section: every racer must acquire
  // this lock before it (re-)checks for an active session. As long as both
  // racers go through this same acquire-then-check path, the lock serializes
  // them — the loser blocks until the winner's transaction ends, then
  // re-checks and finds the winner's session already active. The lock is
  // released automatically when the transaction ends, whether by commit or
  // by a thrown RepoError below (transaction rollback), so an error here
  // never leaves the task's session slot stuck locked.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.taskId}))`);

    const active = await listActiveSessions(input.taskId);
    if (active.length > 0) {
      throw new repo.RepoError(
        `Task ${input.taskId} already has an active session (#${active[0].id})`,
        409
      );
    }
    if (input.resumeOf) {
      const prior = await runs.get(input.resumeOf);
      if (!prior) throw new repo.RepoError(`Prior session #${input.resumeOf} not found`, 404);
      if (prior.taskId !== input.taskId) {
        throw new repo.RepoError(`Session #${input.resumeOf} belongs to a different task`, 400);
      }
      if (!prior.sdkSessionId) {
        throw new repo.RepoError(
          `Session #${input.resumeOf} has no SDK session id — nothing to resume`,
          400
        );
      }
    }

    const created = await runs.create({
      goal: "<implement>",
      cwdStrategy: "worktree",
      // gh_pr/gh_ci let the agent inspect its own PR and fetch CI results
      // (e.g. when reacting to webhook-driven CI failures).
      toolsProfile: "orchestrator,repo_write,gh_pr,gh_ci",
      taskId: input.taskId,
      repoId: task.repoId ?? null,
      model: input.model ?? DEFAULT_MODEL,
      thinkingLevel: input.thinkingLevel ?? null,
      baseBranch: input.baseBranch ?? "main",
      parentRunId: input.resumeOf ?? input.parentRunId ?? null,
      userId: input.userId ?? null,
    });

    return runs.toAgentSessionFull(created);
  });
}

export async function listSessions(taskId?: string): Promise<AgentSessionFull[]> {
  const rows = await runs.list({
    goal: "<implement>",
    taskId: taskId ?? undefined,
  });
  return rows.filter((r) => r.taskId != null).map((r) => runs.toAgentSessionFull(r));
}

export async function listActiveSessions(taskId?: string): Promise<AgentSessionFull[]> {
  const rows = await runs.list({
    goal: "<implement>",
    taskId: taskId ?? undefined,
    activeOnly: true,
  });
  return rows.filter((r) => r.taskId != null).map((r) => runs.toAgentSessionFull(r));
}

export async function getSession(id: number): Promise<AgentSessionFull | null> {
  const r = await runs.get(id);
  if (!r || r.taskId == null) return null;
  return runs.toAgentSessionFull(r);
}

export async function getSessionEvents(
  sessionId: number,
  sinceId = 0,
  limit?: number
): Promise<AgentEventRow[]> {
  const where =
    sinceId > 0
      ? and(eq(agentEvents.sessionId, sessionId), gt(agentEvents.id, sinceId))
      : eq(agentEvents.sessionId, sessionId);
  if (limit && limit > 0) {
    const tail = await db
      .select()
      .from(agentEvents)
      .where(where)
      .orderBy(desc(agentEvents.id))
      .limit(limit);
    tail.reverse();
    return tail.map(toEventRow);
  }
  return (
    await db
      .select()
      .from(agentEvents)
      .where(where)
      .orderBy(asc(agentEvents.id))
  ).map(toEventRow);
}

function toEventRow(e: typeof agentEvents.$inferSelect): AgentEventRow {
  return {
    id: e.id,
    sessionId: e.sessionId,
    type: e.type,
    payload: safeJson(e.payload),
    createdAt: e.createdAt,
  };
}

export function subscribe(
  sessionId: number,
  listener: (event: AgentEventRow) => void
): () => void {
  // Bridge runs.ts bus events ({ type, status, error, ... } or
  // { type: 'sdk', sdk } shapes) to the AgentEventRow shape this module's
  // existing SSE consumers expect. We synthesise an id/createdAt; live
  // consumers only key off `type` + `payload`.
  return runs.subscribe(sessionId, (raw) => {
    const obj = raw as {
      type?: string;
      status?: string;
      sdk?: unknown;
      error?: string;
      payload?: unknown;
    };
    let payload: unknown;
    if (obj.type === "status") {
      payload = { status: obj.status, ...(obj.error ? { error: obj.error } : {}) };
    } else if (obj.type === "sdk") {
      payload = obj.sdk;
    } else if ("payload" in obj) {
      // Events emitted via runs.emitRunEvent carry an explicit payload (e.g.
      // the GitHub webhook handler's `github` events).
      payload = obj.payload;
    } else {
      payload = obj;
    }
    listener({
      id: 0,
      sessionId,
      type: obj.type ?? "event",
      payload,
      createdAt: new Date(),
    });
  });
}

export function isLive(sessionId: number): boolean {
  return runs.isLive(sessionId);
}

export async function cancelSession(sessionId: number): Promise<AgentSessionFull> {
  const session = await getSession(sessionId);
  if (!session) throw new repo.RepoError(`Session ${sessionId} not found`, 404);
  if (isTerminalStatus(session.status)) return session;
  const cancelled = await runs.cancel(sessionId);
  return runs.toAgentSessionFull(cancelled);
}

// ──────────────────────────────────────────────────────────
// Helpers retained for cleanup paths
// ──────────────────────────────────────────────────────────

async function repoRootForSession(taskId: string): Promise<string> {
  const repoRow = await repo.resolveRepoForTask(taskId);
  if (repoRow?.localPath) return resolve(repoRow.localPath);
  return ORCHESTRATOR_ROOT;
}

function cleanupWorktree(path: string, repoRoot: string): Promise<void> {
  if (process.env.TASK_ORCH_KEEP_WORKTREES) return Promise.resolve();
  return new Promise((res) => {
    const child = spawn("git", ["worktree", "remove", "--force", path], { cwd: repoRoot });
    child.on("close", () => res());
    child.on("error", () => res());
  });
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

// Test hook: reset the reaper guard and run reapOrphans for testing.
export async function _reapOrphansForTest(): Promise<void> {
  globalThis.__agentReaperRan = false;
  return reapOrphans();
}
