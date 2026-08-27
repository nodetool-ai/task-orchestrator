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
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentEvents, agentSessions } from "@/db/schema";
import { autoLaunchEligibleTasks, autoLaunchEnabled, autoLaunchIntervalMs } from "./auto-launch";
import { syncPrBackedTasks } from "./pr-task-state";
import * as repo from "./repo";
import { insideWorker } from "./runner/provider";
import { resolveLiveness } from "./run-liveness";
import * as runs from "./runs";
import {
  isTerminalStatus,
  type AgentEventRow,
  type AgentSessionFull,
} from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT = resolve(__dirname, "..");
const DEFAULT_MODEL = process.env.TASK_ORCH_AGENT_MODEL ?? "claude-opus-4-8";

// ──────────────────────────────────────────────────────────
// Background tasks (orphan reaper, PR → task-state sync).
//
// These need to run regardless of whether anyone imports lib/runs.ts, so
// they live here on the legacy module that every API route already touches.
//
// ORCHESTRATOR-ONLY: both jobs read the DB directly. Under the HTTP-worker
// architecture (#98) a run worker (TASK_ORCH_INSIDE_WORKER=1) holds no DB
// access — the db guard throws on every call — so firing these inside a worker
// only spams caught "reaper/pr sync failed" errors and wastes a poll timer.
// Reaping orphans and syncing PR-backed task state are control-plane duties
// anyway; gate them so they run on the server only.
// ──────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __agentReaperRan: boolean | undefined;
  // eslint-disable-next-line no-var
  var __agentPrWatcher: NodeJS.Timeout | undefined;
  // eslint-disable-next-line no-var
  var __agentAutoLauncher: NodeJS.Timeout | undefined;
}

// Declared before the module-init reaper invocation below. reapOrphans() is a
// hoisted function, but this `const` is not: with the declaration placed after
// the invocation, reapOrphans' `.filter(... NON_TERMINAL_BUT_DEAD.includes ...)`
// reads it in the temporal dead zone whenever the boot DB actually has an
// implement run to filter — a TDZ ReferenceError swallowed as "reaper failed"
// (empty test DBs never enter the filter callback, so the suite stayed green).
const NON_TERMINAL_BUT_DEAD = ["pending", "preparing", "running"];

// Grace period for pending rows before treating as orphaned. Fresh pending rows
// are the dispatch queue — owned by the creating process's kickoff or the
// detached pump in lib/run-dispatch.ts. Only an old one indicates the owning
// process died before dispatch.
const PENDING_GRACE_PERIOD_MS = 15 * 60_000; // 15 minutes

if (!insideWorker() && !globalThis.__agentReaperRan) {
  globalThis.__agentReaperRan = true;
  reapOrphans().catch((err) => {
    console.error("agent: reaper failed:", err);
  });
}

// PR → task-state sync cadence ("as often as possible" belt that catches
// missed webhooks). TASK_ORCH_PR_SYNC_MS is the current knob; fall back to the
// legacy TASK_ORCH_PR_POLL_MS if only that is set, else default 20s.
const PR_SYNC_MS = Number(
  process.env.TASK_ORCH_PR_SYNC_MS ?? process.env.TASK_ORCH_PR_POLL_MS ?? 20_000
);
if (!insideWorker() && !globalThis.__agentPrWatcher && PR_SYNC_MS > 0) {
  globalThis.__agentPrWatcher = setInterval(() => {
    syncPrBackedTasks().catch((err) => console.error("agent: pr sync failed:", err));
  }, PR_SYNC_MS);
  globalThis.__agentPrWatcher.unref?.();
}

// Proactive scheduler (lib/auto-launch.ts): auto-launch agent sessions on
// eligible `todo` tasks so the orchestrator runs autonomously. OFF by default —
// the interval is armed ONLY when TASK_ORCH_AUTO_LAUNCH is explicitly enabled,
// so there is zero overhead (no timer, no DB scan) when the feature is off.
// ORCHESTRATOR-ONLY, same as the PR-sync poller above: a run worker holds no DB
// access, so this control-plane duty runs on the server only.
if (
  !insideWorker() &&
  !globalThis.__agentAutoLauncher &&
  autoLaunchEnabled() &&
  autoLaunchIntervalMs() > 0
) {
  globalThis.__agentAutoLauncher = setInterval(() => {
    autoLaunchEligibleTasks().catch((err) =>
      console.error("agent: auto-launch failed:", err)
    );
  }, autoLaunchIntervalMs());
  globalThis.__agentAutoLauncher.unref?.();
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
    // A resumable worktree implement run (branch + SDK session persist) is the
    // pump's job, not ours: runs.reconcileOrphanedRuns re-dispatches it to a
    // fresh worker. Failing it here — and worse, removing its worktree below —
    // would abandon recoverable work on a plain restart. Defer to the pump.
    if (
      (row.status === "preparing" || row.status === "running") &&
      row.cwdStrategy === "worktree" &&
      !!row.branch &&
      !!row.sdkSessionId
    ) {
      return false;
    }
    // Plan-executor <execute> runs resume from Postgres alone (no worktree);
    // reconcileOrphanedRuns redispatches them too. Leave them for the pump.
    if (
      (row.status === "preparing" || row.status === "running") &&
      row.goal === "<execute>" &&
      !!row.planId
    ) {
      return false;
    }
    // pending rows are fresh dispatch-queue entries; only reap if genuinely
    // stale. Measure from pending_since (the pump re-defers long-lived runs into
    // `pending` and stamps it), falling back to startedAt.
    if (row.status === "pending") {
      const since = (row.pendingSince ?? row.startedAt).getTime();
      return now.getTime() - since > PENDING_GRACE_PERIOD_MS;
    }
    return true;
  });

  for (const orphan of orphans) {
    // Never reap a run that is genuinely in flight:
    //   • runs.isLive → an in-process runner exists here.
    //   • resolveLiveness alive → the provider observes its worker, i.e. a
    //     turn running in ANOTHER process (this reaper fires on every module
    //     import — Next server boot, but also short-lived cli.ts / pipe
    //     processes that share the SQLite DB).
    // Without the lease check, a CLI invocation while the Next server has an
    // implement run mid-turn would flip it to `failed` AND `git worktree remove
    // --force` the worktree the live agent is editing, destroying its work.
    // Mirror runs.reconcileOrphanedRuns(), which uses the same lease guard.
    if (runs.isLive(orphan.id)) continue;
    const liveness = await resolveLiveness(orphan.id);
    if (liveness.verdict === "alive" || liveness.verdict === "unknown") {
      if (liveness.verdict === "unknown") console.warn(`[liveness] leaving boot orphan ${orphan.id} alone: provider observation unknown`);
      continue;
    }
    const now = new Date();
    // CAS guard: only fail the row if it's STILL in the snapshot status with no
    // fresh claim. The liveness check above is a stale snapshot — a
    // dispatch that claimed this row (status→preparing, fresh heartbeat) between
    // our SELECT and here must not be clobbered to `failed`, nor have its
    // worktree removed underneath the live turn.
    let reaped = false;
    // One transaction for the status column write and its paired event: the same
    // both-or-neither guarantee the runs.ts finalize path now gives — a lost
    // column write must never leave the event orphaned (and vice versa).
    await db.transaction(async (tx) => {
      const res = await tx.update(agentSessions)
        .set({
          status: "failed",
          error: orphan.error ?? "Orphaned by server restart",
          completedAt: now,
        })
        .where(
          and(
            eq(agentSessions.id, orphan.id),
            eq(agentSessions.status, orphan.status),
            orphan.workerScope == null
              ? isNull(agentSessions.workerScope)
              : eq(agentSessions.workerScope, orphan.workerScope)
          )
        );
      // drizzle/postgres exposes affected-row count as `rowCount`/`count`.
      const affected = (res as { rowCount?: number; count?: number }).rowCount
        ?? (res as { count?: number }).count ?? 0;
      if (affected === 0) return; // a concurrent claim owns it now — leave it alone
      reaped = true;
      await tx.insert(agentEvents)
        .values({
          sessionId: orphan.id,
          type: "status",
          payload: JSON.stringify({ status: "failed", error: "Orphaned by server restart" }),
          createdAt: now,
        });
    });
    if (reaped && orphan.worktreePath && orphan.taskId) {
      const root = await repoRootForSession(orphan.taskId);
      cleanupWorktree(orphan.worktreePath, root).catch(() => {});
    }
  }
}

// ──────────────────────────────────────────────────────────
// Public API (legacy shape; delegates to lib/runs.ts)
// ──────────────────────────────────────────────────────────

export interface StartSessionInput {
  taskId: string;
  model?: string;
  /** Agent backend ('pi'|'claude'). Omitted: a resume inherits the prior
   *  session's backend (its resume token is backend-tagged); a fresh session
   *  uses the deployment default. */
  backend?: "pi" | "claude" | null;
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

  // One active agent per task is enforced inside runs.create() itself: the
  // insert runs in a transaction holding a per-task advisory lock and 409s
  // when the task already has an active worktree session. It used to be
  // guarded HERE (M17c) with the same lock around a check-then-create; that
  // moved into create() so every creation path (REST, spawn tool, attached-run
  // endpoint, auto-launch) is covered by one lock on one connection. Do NOT
  // re-wrap this call in a transaction taking that lock — create()'s inner
  // transaction runs on a different pooled connection and would deadlock.
  let backend = input.backend ?? null;
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
    // A resume stays on the prior session's backend unless overridden: its
    // resume token is backend-tagged, so a different backend starts fresh.
    backend = backend ?? prior.backend;
  }

  const persona = await repo.getPersona("implementor");
  // Mirror runs.create()'s model resolution: an explicit per-call model wins,
  // otherwise fall back to the implementor persona's modelProvider/modelId
  // (as selected in Settings → Personas), then the deployment default.
  // Pre-filling with DEFAULT_MODEL here would shadow runs.create()'s own
  // persona fallback (it only fires when input.model is null/undefined),
  // so executor-spawned children used to land on TASK_ORCH_AGENT_MODEL /
  // "claude-sonnet-4-6" regardless of the persona model picked in settings.
  const personaModel =
    persona && persona.modelProvider && persona.modelId
      ? `${persona.modelProvider}/${persona.modelId}`
      : null;
  const created = await runs.create({
    goal: "<implement>",
    cwdStrategy: "worktree",
    // gh_pr/gh_ci let the agent inspect its own PR and fetch CI results
    // (e.g. when reacting to webhook-driven CI failures).
    toolsProfile: "orchestrator,repo_write,gh_pr,gh_ci",
    taskId: input.taskId,
    repoId: task.repoId ?? null,
    model: input.model ?? personaModel ?? DEFAULT_MODEL,
    backend,
    thinkingLevel: input.thinkingLevel ?? null,
    baseBranch: input.baseBranch ?? "main",
    parentRunId: input.resumeOf ?? input.parentRunId ?? null,
    userId: input.userId ?? null,
    personaId: "implementor",
    budget: {
      maxTurns: persona?.budgetMaxTurns ?? undefined,
      maxSeconds: persona?.budgetMaxSeconds ?? undefined,
    },
  });

  return runs.toAgentSessionFull(created);
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

// Test hook: reset the reaper guard and run reapOrphans for testing.
export async function _reapOrphansForTest(): Promise<void> {
  globalThis.__agentReaperRan = false;
  return reapOrphans();
}
