// lib/worker/db-transport.ts
//
// The direct-Postgres implementation of RunTransport. This is BOTH:
//   • the transport a worker uses when it has database access (the default,
//     exactly the behavior that existed before the transport seam), and
//   • the single implementation backing the /api/worker/* HTTP routes — the
//     http transport is a wire mirror of this one, so persistence semantics
//     live in exactly one place.
//
// Import discipline: lib/runs.ts calls into this module (via lib/worker), and
// several methods here delegate back to lib/runs.ts exports (get, applyStatusTx,
// injectPendingInboxEvents, …) because those are entangled with runs.ts module
// state (the live bus, the child-event producers). That back-edge is a LAZY
// dynamic import (memoized) so module init stays acyclic.

import { and, count, eq, gt, notInArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentEvents, agentMessages, agentSessions, resourceLocks } from "../../db/schema";
import * as repo from "../repo";
import { markControlInjected } from "../inbox";
import { subscribeRunInput } from "../run-stream-listener";
import {
  LEASE_STATUSES,
  SESSION_STATUSES,
  isTerminalStatus,
  type PlanState,
  type SessionStatus,
} from "../types";
import { WORKER_LOG_MAX_CHARS } from "../runner/worker-log-store";
import { createLogger } from "./log";
import { contentText } from "./protocol";
import type {
  ApplyStatusOpts,
  HeartbeatResult,
  MessageRole,
  RunPatch,
  RunTransport,
  StatusSet,
  TaskTransitionInput,
  WireStatusGuard,
} from "./protocol";

const log = createLogger("worker-transport-db");

const TERMINAL_STATUSES: SessionStatus[] = SESSION_STATUSES.filter(isTerminalStatus);

// Lazy, memoized back-edge into lib/runs.ts (see the module docstring).
type RunsModule = typeof import("../runs");
let runsModule: Promise<RunsModule> | null = null;
function runs(): Promise<RunsModule> {
  if (!runsModule) runsModule = import("../runs");
  return runsModule;
}

function guardToSql(guard: WireStatusGuard | undefined) {
  switch (guard) {
    case "not-terminal":
      return notInArray(agentSessions.status, TERMINAL_STATUSES);
    case "not-cancelled-closed":
      return notInArray(agentSessions.status, ["cancelled", "closed"]);
    default:
      return undefined;
  }
}

/** Normalize a wire-form StatusSet/RunPatch date to a Date for drizzle. */
function toDate(v: Date | string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v instanceof Date) return v;
  return new Date(v);
}

function statusSetToColumns(set: StatusSet | undefined) {
  if (!set) return {};
  const out: Record<string, unknown> = {};
  if ("sdkSessionId" in set) out.sdkSessionId = set.sdkSessionId;
  if ("totalCostUsd" in set) out.totalCostUsd = set.totalCostUsd;
  if ("inputTokens" in set) out.inputTokens = set.inputTokens;
  if ("outputTokens" in set) out.outputTokens = set.outputTokens;
  if ("outcome" in set) out.outcome = set.outcome;
  if ("prUrl" in set) out.prUrl = set.prUrl;
  if ("parkReason" in set) out.parkReason = set.parkReason;
  // result is a jsonb column — pass the value through, drizzle serializes.
  if ("result" in set) out.result = set.result ?? null;
  if ("error" in set) out.error = set.error;
  if ("completedAt" in set) out.completedAt = toDate(set.completedAt);
  return out;
}

export const dbTransport: RunTransport = {
  kind: "db",

  // getRun/listMessages are implemented directly (not delegated to runs.ts):
  // runs.get()/listMessages() themselves route through the transport, so a
  // delegation here would recurse.
  async getRun(runId) {
    const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, runId));
    return rows.length ? (await runs()).hydrateRun(rows[0]) : null;
  },

  async listMessages(runId) {
    const rows = await db
      .select()
      .from(agentMessages)
      .where(eq(agentMessages.runId, runId))
      .orderBy(agentMessages.id);
    const { hydrateMessage } = await runs();
    return rows.map(hydrateMessage);
  },

  async appendMessage(runId, role: MessageRole, content, opts) {
    const idempotencyKey = opts?.idempotencyKey?.trim() || undefined;
    const inserted = await db
      .insert(agentMessages)
      .values({
        runId,
        role,
        content: JSON.stringify(content),
        idempotencyKey,
        createdAt: new Date(),
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted[0] ??
      (idempotencyKey
        ? (
            await db
              .select()
              .from(agentMessages)
              .where(and(eq(agentMessages.runId, runId), eq(agentMessages.idempotencyKey, idempotencyKey)))
          )[0]
        : null);
    if (!row) {
      throw new Error("Message append conflicted but no idempotent row was found");
    }
    return (await runs()).hydrateMessage(row);
  },

  async appendEvent(runId, type, payload) {
    await db.insert(agentEvents).values({
      sessionId: runId,
      type,
      payload: JSON.stringify(payload),
      createdAt: new Date(),
    });
  },

  async countEvents(runId, type) {
    const rows = await db
      .select({ n: count() })
      .from(agentEvents)
      .where(and(eq(agentEvents.sessionId, runId), eq(agentEvents.type, type)));
    return rows[0]?.n ?? 0;
  },

  async applyStatus(runId, status, opts: ApplyStatusOpts = {}) {
    // Delegate to runs.applyStatusTx — the transactional core plus its
    // post-commit side effects (child lifecycle event; the in-process bus emit
    // is a no-op unless this process is the one driving the turn).
    return (await runs()).applyStatusTx(runId, status, {
      set: statusSetToColumns(opts.set) as never,
      guard: guardToSql(opts.guard),
      extra: opts.extra,
      retries: opts.retries,
    });
  },

  async setStatus(runId, status) {
    if (isTerminalStatus(status)) {
      await this.applyStatus(runId, status, { guard: "not-terminal" });
      return;
    }
    // Entering a lease status must stamp the heartbeat IN THE SAME WRITE.
    // In-process turns (append/runReview/runExecute) open their lease via this
    // transition — not via a dispatch claim — and their heartbeat interval's
    // first beat lands only after this write. In that window a fresh run's
    // heartbeat_at is NULL (and a resumed idle chat's is hours old), and
    // reconcileOrphanedRuns grants a lease-status row without a fresh beat NO
    // grace: a pump tick (here or on another web instance) would fail the live
    // turn as "Worker heartbeat lost … (no heartbeat recorded; scope none)".
    const set = LEASE_STATUSES.includes(status)
      ? { status, heartbeatAt: new Date() }
      : { status };
    await db.update(agentSessions).set(set).where(eq(agentSessions.id, runId));
    // Best-effort non-terminal event mirror (legacy /sessions UI): a lost
    // mirror is harmless — the next transition re-establishes state.
    try {
      await this.appendEvent(runId, "status", { status });
    } catch {
      // ignore event mirror failures
    }
  },

  async patchRun(runId, patch: RunPatch) {
    const set: Record<string, unknown> = {};
    if ("sdkSessionId" in patch) set.sdkSessionId = patch.sdkSessionId;
    if ("branch" in patch) set.branch = patch.branch;
    if ("worktreePath" in patch) set.worktreePath = patch.worktreePath;
    if ("repoId" in patch) set.repoId = patch.repoId;
    if ("prUrl" in patch) set.prUrl = patch.prUrl;
    if ("result" in patch) set.result = patch.result ?? null; // jsonb — no stringify
    if ("parkReason" in patch) set.parkReason = patch.parkReason;
    if ("planningStage" in patch) set.planningStage = patch.planningStage;
    if ("completedAt" in patch) set.completedAt = toDate(patch.completedAt);
    if (patch.incrementAttempt) set.attempt = sql`${agentSessions.attempt} + 1`;
    if (Object.keys(set).length === 0) return;
    await db.update(agentSessions).set(set).where(eq(agentSessions.id, runId));
  },

  async heartbeat(runId): Promise<HeartbeatResult> {
    // One round-trip: bump the lease AND read back the cancel flag.
    const rows = await db
      .update(agentSessions)
      .set({ heartbeatAt: new Date() })
      .where(eq(agentSessions.id, runId))
      .returning({ c: agentSessions.cancelRequested });
    return { cancelRequested: rows[0]?.c === 1 };
  },

  async ackCancel(runId) {
    await markControlInjected(runId, "run.cancel_requested");
  },

  async releaseClaim(runId, { lastProcessedUserMsgId, idleIfNonTerminal }) {
    // Release the worker claim, guarded on the row NOT being in a lease status:
    // a lease status here can only mean a false death report released this
    // claim mid-turn and a re-dispatched worker re-claimed — clearing THAT
    // worker's healthy claim would strand it.
    await db
      .update(agentSessions)
      .set({ workerScope: null, workerPid: null })
      .where(and(eq(agentSessions.id, runId), notInArray(agentSessions.status, LEASE_STATUSES)));
    const cur = await this.getRun(runId);
    if (!cur) return;
    // Chat-loop exit: land the run resumable-idle unless cancel/close already
    // wrote a terminal row or the turn deliberately parked for an event/timer.
    // Ordered BEFORE the stranded re-dispatch so a fresh dispatch's 'preparing'
    // claim is never clobbered back to 'idle'.
    if (idleIfNonTerminal && !isTerminalStatus(cur.status) && cur.status !== "parked") {
      await this.setStatus(runId, "idle");
    }
    // Stranded-message drain: a non-empty user message that arrived while the
    // exiting worker held the claim was rejected by dispatchRun
    // ("already-claimed") — with the claim now released, re-dispatch so a fresh
    // worker picks it up. The re-dispatch gate matches the exiting loop's own
    // semantics (judged on the PRE-idle status):
    //   • chat exit (idleIfNonTerminal): never resurrect ANY terminal landing —
    //     a failed/budget_exhausted/cancelled chat must not re-dispatch itself
    //     in a loop over the same stranded message;
    //   • single-turn exit: only cancel/close block it — a completed implement
    //     run with a mid-turn follow-up is deliberately revived (FIX 3a/M7).
    const allowRedispatch = idleIfNonTerminal
      ? !isTerminalStatus(cur.status)
      : cur.status !== "cancelled" && cur.status !== "closed";
    if (!allowRedispatch) return;
    // Targeted read: only user rows newer than the watermark (not the whole
    // conversation) — this runs on every worker exit.
    const newerUserRows = await db
      .select({ content: agentMessages.content })
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.runId, runId),
          eq(agentMessages.role, "user"),
          gt(agentMessages.id, lastProcessedUserMsgId)
        )
      );
    const stranded = newerUserRows.some((r) => {
      try {
        return contentText(JSON.parse(r.content)) !== "";
      } catch {
        return false;
      }
    });
    if (stranded) {
      log.info("stranded user message after release; re-dispatching", { runId });
      const dispatch = await import("../run-dispatch");
      void dispatch.dispatchRun(runId).catch(() => {});
    }
  },

  async subscribeInput(runId, onInput) {
    return subscribeRunInput(runId, onInput);
  },

  async claimInboxDigest(runId) {
    return (await runs()).injectPendingInboxEvents(runId);
  },

  async writeWorkerLog(runId, tail) {
    await db
      .update(agentSessions)
      // Defensive re-cap: the column is a bounded forensic tail, never a full log.
      .set({ workerLog: tail.slice(-WORKER_LOG_MAX_CHARS) })
      .where(eq(agentSessions.id, runId));
  },

  async getTask(taskId) {
    return repo.getTask(taskId);
  },

  async transitionTask(taskId, input: TaskTransitionInput) {
    await repo.transitionTask(taskId, input);
  },

  async addTaskNote(taskId, author, body) {
    await repo.addNote(taskId, author, body);
  },

  async getPlan(planId) {
    return repo.getPlan(planId);
  },

  async listTasks(filter) {
    return repo.listTasks(filter);
  },

  async updatePlanState(planId, state) {
    await repo.updatePlan(planId, { state: state as PlanState });
  },

  async getPersona(personaId) {
    return repo.getPersona(personaId);
  },

  async listRepoRemotes() {
    return (await repo.listRepositories()).map((r) => ({
      id: r.id,
      name: r.name,
      remote: r.remote,
    }));
  },

  async acquirePrLock(runId, prUrl) {
    // Resource-lock guard (§5.2): a `pr:<url>` lease answers "which run owns
    // this PR right now". A different LIVE (non-terminal) owner refuses the
    // mutation; a dead owner's lease is taken over.
    const resource = `pr:${prUrl}`;
    const existing = (
      await db
        .select({ ownerRunId: resourceLocks.ownerRunId })
        .from(resourceLocks)
        .where(eq(resourceLocks.resource, resource))
    )[0];
    if (existing && existing.ownerRunId !== runId) {
      const ownerRow = (
        await db
          .select({ status: agentSessions.status })
          .from(agentSessions)
          .where(eq(agentSessions.id, existing.ownerRunId))
      )[0];
      const ownerAlive = ownerRow
        ? !isTerminalStatus(ownerRow.status as SessionStatus)
        : false;
      if (ownerAlive) {
        return {
          ok: false,
          reason: `run #${existing.ownerRunId} owns this PR (${prUrl}); append_message it instead of mutating the PR directly.`,
        };
      }
    }
    await db
      .insert(resourceLocks)
      .values({ resource, ownerRunId: runId })
      .onConflictDoUpdate({
        target: resourceLocks.resource,
        set: { ownerRunId: runId, acquiredAt: new Date() },
      });
    return { ok: true };
  },

  async callTool(runId, tool, params, ctx) {
    // Lazy import: the registry modules statically import runs.ts (see the
    // module docstring's import discipline).
    const { resolveServerTool } = await import("./server-tools");
    const def = await resolveServerTool(tool);
    if (!def) return { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true };
    return def.execute(params, { ...ctx, runId });
  },

  async resolveRepo(runId) {
    const run = await this.getRun(runId);
    if (!run) return null;
    if (run.repoId) {
      const r = await repo.getRepository(run.repoId);
      if (r) return r;
    }
    if (run.taskId) {
      const r = await repo.resolveRepoForTask(run.taskId);
      if (r) return r;
    }
    return repo.defaultRepo();
  },
};
