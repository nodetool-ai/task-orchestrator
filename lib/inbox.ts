// lib/inbox.ts
//
// Core of the agent event system (docs/agent-events.md): the durable inbox.
//
// Exactly two mutation paths touch inbox_events rows:
//   - emitInboxEvent()   — producers write facts; addressing (owner +
//                          supervisor copies + exception routing +
//                          supersession + dedupe) lives HERE, in one place.
//   - claimInboxEvents() — the single claim primitive. Turn-boundary digest
//                          injection and mid-turn events__poll both go
//                          through it. Control-class events are excluded
//                          inside the primitive, not by caller convention.
//
// This module depends only on db/schema and lib/types; anything that needs
// the runner (waking a parked run) goes through a lazy dynamic import so
// runs.ts / run-dispatch.ts can import us without a cycle.

import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  agentMessages,
  agentSessions,
  inboxEvents,
  runTimers,
  type InboxEvent,
  type RunTimer,
} from "@/db/schema";
import { isTerminalStatus, type SessionStatus } from "./types";

// ────────────────────────────────────────
// Taxonomy & classes
// ────────────────────────────────────────

export type Audience = "owner" | "supervisor";
export type SourceKind = "run" | "github" | "timer" | "task" | "budget" | "system" | "user";

/**
 * Control class (§6.6): facts the PLATFORM enforces (heartbeat-cadence abort,
 * budget gates), never the LLM. Unclaimable by claimInboxEvents — their rows
 * exist only to make enforcement visible in the next digest, marked
 * `injected` by markControlInjected() when the platform acts.
 */
export const CONTROL_TYPES = new Set<string>([
  "run.cancel_requested",
  "run.budget_exhausted",
]);

/**
 * Terminal child events (§4.3): exactly one per (run, attempt), and a newer
 * attempt's terminal event supersedes older still-pending ones at emit time.
 */
export const TERMINAL_CHILD_TYPES = new Set<string>([
  "child.result",
  "child.exception",
  "child.died",
  "child.cancelled",
]);

/**
 * Parent-visible types (§5.2): when the direct target has a live parent,
 * these get an informational `supervisor` copy (which does NOT wake).
 */
const SUPERVISOR_COPY_PREFIXES = ["gh.", "task.", "plan."];
const SUPERVISOR_COPY_TYPES = new Set<string>(["budget.warning"]);

function wantsSupervisorCopy(type: string): boolean {
  return (
    SUPERVISOR_COPY_TYPES.has(type) ||
    TERMINAL_CHILD_TYPES.has(type) ||
    SUPERVISOR_COPY_PREFIXES.some((p) => type.startsWith(p))
  );
}

// Payloads bigger than this are quarantined at claim time (§6.5) rather than
// injected — one runaway payload must not wedge prompt construction.
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// ────────────────────────────────────────
// Emit
// ────────────────────────────────────────

export interface EmitInput {
  /** Direct target BEFORE supersession-chain resolution (§9.1). */
  targetRunId: number;
  type: string;
  payload?: Record<string, unknown>;
  sourceKind: SourceKind;
  sourceId?: string | null;
  correlationId?: string | null;
  causationEventId?: number | null;
  /** Rework generation of the source child when sourceKind='run'. */
  attempt?: number | null;
  dedupeKey?: string | null;
  /** Skip the wake (e.g. when the caller is about to dispatch anyway). */
  noWake?: boolean;
}

export interface EmitResult {
  /** Inserted owner-event id, or null when deduped away. */
  eventId: number | null;
  /** Resolved target after following superseded_by (§9.1). */
  targetRunId: number;
  /** True if a wake dispatch was attempted. */
  woke: boolean;
}

interface TargetRow {
  id: number;
  status: string;
  parentRunId: number | null;
}

// Generation rollover (§9.1) is unbuilt: nothing writes agent_sessions.superseded_by
// yet, so a run always IS its own current generation. When rollover ships, target
// resolution must follow that pointer chain to the live successor (so in-flight
// children/webhooks addressed to the old run id land in the successor's inbox);
// until then getTargetRow is the whole of "resolve to the current run".
async function getTargetRow(id: number): Promise<TargetRow | null> {
  const row = (
    await db
      .select({
        id: agentSessions.id,
        status: agentSessions.status,
        parentRunId: agentSessions.parentRunId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
  )[0];
  return row ?? null;
}

/** Walk parent_run_id upward to the nearest NON-terminal ancestor (§5.3). */
async function nearestLiveAncestor(startParentId: number | null, maxSteps = 8): Promise<TargetRow | null> {
  let cursor = startParentId;
  let steps = 0;
  const seen = new Set<number>();
  let last: TargetRow | null = null;
  while (cursor != null && steps < maxSteps) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = await getTargetRow(cursor);
    if (!row) break;
    last = row;
    if (!isTerminalStatus(row.status as SessionStatus)) return row;
    cursor = row.parentRunId;
    steps++;
  }
  // No live ancestor: return the topmost we saw (the root) so the caller can
  // still flag an unhandled tree failure — events must never vanish.
  return last;
}

async function insertEvent(
  values: typeof inboxEvents.$inferInsert
): Promise<number | null> {
  const rows = await db
    .insert(inboxEvents)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: inboxEvents.id });
  return rows[0]?.id ?? null;
}

async function mirrorInboxEventMessage(input: {
  targetRunId: number;
  eventId: number;
  type: string;
  payload: Record<string, unknown>;
  audience: Audience;
  sourceKind: SourceKind;
  sourceId?: string | null;
  correlationId?: string | null;
  attempt?: number | null;
  bubbledFrom?: number | null;
}): Promise<void> {
  await db.insert(agentMessages).values({
    runId: input.targetRunId,
    role: "system",
    content: JSON.stringify([
      {
        type: "inbox_event",
        event_id: input.eventId,
        event_type: input.type,
        audience: input.audience,
        source_kind: input.sourceKind,
        source_id: input.sourceId ?? null,
        correlation_id: input.correlationId ?? null,
        attempt: input.attempt ?? null,
        bubbled_from: input.bubbledFrom ?? null,
        payload: input.payload,
      },
    ]),
  });
}

/**
 * Emit one logical event. Handles, in order:
 *  1. target resolution through superseded_by chains (§9.1)
 *  2. supersession of stale pending terminal events from the same child (§4.3)
 *  3. the owner insert (deduped)
 *  4. exception re-routing past a terminal parent (§5.3)
 *  5. a supervisor copy to the live parent for parent-visible types, which
 *     also wakes a parked parent (§5.2)
 *  6. waking a parked target for owner-audience notify events (§6.2)
 */
export async function emitInboxEvent(input: EmitInput): Promise<EmitResult> {
  const resolved = await getTargetRow(input.targetRunId);
  if (!resolved) return { eventId: null, targetRunId: input.targetRunId, woke: false };

  let target: TargetRow = resolved;
  let bubbledFrom: number | null = null;

  // Exception routing (§5.3): child.exception / child.died addressed to a
  // terminal parent re-route to the nearest live ancestor as SUPERVISOR
  // (informed, not conscripted). Other types stay put — a terminal target's
  // pending events are simply never claimed, which is correct and auditable.
  let audience: Audience = "owner";
  if (
    (input.type === "child.exception" || input.type === "child.died") &&
    isTerminalStatus(target.status as SessionStatus)
  ) {
    const ancestor = await nearestLiveAncestor(target.parentRunId);
    if (ancestor && ancestor.id !== target.id) {
      bubbledFrom = target.id;
      target = ancestor;
      audience = "supervisor";
    }
  }

  // Supersession (§4.3): a newer terminal event from child R invalidates any
  // still-pending terminal event from R with a lower attempt, atomically with
  // the insert (same transaction — a parent must never observe the new event
  // without the stale one being superseded).
  const eventId = await db.transaction(async (tx) => {
    if (
      TERMINAL_CHILD_TYPES.has(input.type) &&
      input.sourceKind === "run" &&
      input.sourceId != null &&
      input.attempt != null
    ) {
      await tx
        .update(inboxEvents)
        .set({ status: "superseded" })
        .where(
          and(
            eq(inboxEvents.targetRunId, target.id),
            eq(inboxEvents.sourceKind, "run"),
            eq(inboxEvents.sourceId, String(input.sourceId)),
            eq(inboxEvents.status, "pending"),
            inArray(inboxEvents.type, [...TERMINAL_CHILD_TYPES]),
            lt(inboxEvents.attempt, input.attempt)
          )
        );
    }
    const rows = await tx
      .insert(inboxEvents)
      .values({
        targetRunId: target.id,
        type: input.type,
        payload: input.payload ?? {},
        audience,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        correlationId: input.correlationId ?? null,
        causationEventId: input.causationEventId ?? null,
        attempt: input.attempt ?? null,
        bubbledFrom,
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: inboxEvents.id });
    return rows[0]?.id ?? null;
  });
  if (eventId != null) {
    await mirrorInboxEventMessage({
      targetRunId: target.id,
      eventId,
      type: input.type,
      payload: input.payload ?? {},
      audience,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId ?? null,
      correlationId: input.correlationId ?? null,
      attempt: input.attempt ?? null,
      bubbledFrom,
    }).catch(() => {});
  }

  // Supervisor copy (§5.2) — informational AND wakes a parked parent (§5.2a): a
  // parked coordinator must not sleep through anything it is supervising. The copy
  // is informational (no action expected — the owning run acts), but its ARRIVAL
  // wakes, because a completed plan can reach a parked executor ONLY as a
  // supervisor copy: gh.pr.merged targets the implementor child that owns the PR,
  // which is terminal by merge time, so the copy to the parent is the sole wake.
  // Best-effort, mirroring the owner wake below; the pump sweep is the backstop.
  if (audience === "owner" && wantsSupervisorCopy(input.type) && target.parentRunId != null) {
    const parent = await getTargetRow(target.parentRunId);
    if (parent && !isTerminalStatus(parent.status as SessionStatus)) {
      const copyId = await insertEvent({
        targetRunId: parent.id,
        type: input.type,
        payload: input.payload ?? {},
        audience: "supervisor",
        sourceKind: input.sourceKind,
        sourceId: input.sourceId ?? null,
        correlationId: input.correlationId ?? null,
        causationEventId: input.causationEventId ?? null,
        attempt: input.attempt ?? null,
        bubbledFrom: target.id,
        dedupeKey: input.dedupeKey ? `sup:${input.dedupeKey}` : null,
      }).catch(() => null);
      if (copyId != null) {
        await mirrorInboxEventMessage({
          targetRunId: parent.id,
          eventId: copyId,
          type: input.type,
          payload: input.payload ?? {},
          audience: "supervisor",
          sourceKind: input.sourceKind,
          sourceId: input.sourceId ?? null,
          correlationId: input.correlationId ?? null,
          attempt: input.attempt ?? null,
          bubbledFrom: target.id,
        }).catch(() => {});
      }
      if (copyId != null && !input.noWake && parent.status === "parked") {
        try {
          const runDispatch = await import("./run-dispatch");
          void runDispatch.dispatchRun(parent.id).catch(() => {});
        } catch {
          // pump sweep will retry
        }
      }
    }
  }

  // Wake (§6.2): pending owner-audience notify event + parked target →
  // dispatch. Control events never wake through this path (the platform
  // enforcement they mirror has its own machinery). Lazy import to avoid a
  // module cycle; failure is fine — the pump wake sweep is the durable belt.
  let woke = false;
  if (
    eventId != null &&
    !input.noWake &&
    audience === "owner" &&
    !CONTROL_TYPES.has(input.type) &&
    target.status === "parked"
  ) {
    try {
      const runDispatch = await import("./run-dispatch");
      void runDispatch.dispatchRun(target.id).catch(() => {});
      woke = true;
    } catch {
      // pump sweep will retry
    }
  }

  return { eventId, targetRunId: target.id, woke };
}

// ────────────────────────────────────────
// Claim
// ────────────────────────────────────────

export interface ClaimOptions {
  audiences?: Audience[];
  types?: string[];
  max?: number;
  /** agent_messages id of the digest frame this claim feeds (§6.4). Callers
   *  that persist the frame after claiming may stamp it via
   *  setClaimTurn(). */
  runTurnId?: number | null;
}

/** The drizzle transaction handle type (the callback param of db.transaction). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The claim SQL (§6.3), runnable inside a CALLER-OWNED transaction. This is the
 * half of the primitive that flips pending→injected: the inner SELECT ...
 * FOR UPDATE SKIP LOCKED + ordered subquery makes the claim atomic and ordered
 * (concurrent claimers get disjoint sets, never dupes), and the UPDATE stamps
 * the claimed rows. Control-class events are excluded HERE, not by caller
 * convention: the LLM never processes its own death warrant.
 *
 * Digest injection (§6.4) runs this inside the SAME tx as the frame INSERT, so
 * claim + transcript-persist commit together — "claimed but never written
 * anywhere" cannot exist. events__poll uses the self-contained wrapper below.
 */
export async function claimInboxEventsTx(
  tx: DbTx,
  runId: number,
  opts: ClaimOptions = {}
): Promise<InboxEvent[]> {
  const audiences = opts.audiences ?? ["owner", "supervisor"];
  const max = Math.max(1, Math.min(opts.max ?? 200, 500));
  const conditions = [
    eq(inboxEvents.targetRunId, runId),
    eq(inboxEvents.status, "pending"),
    inArray(inboxEvents.audience, audiences),
    sql`${inboxEvents.type} NOT IN (${sql.join(
      [...CONTROL_TYPES].map((t) => sql`${t}`),
      sql`, `
    )})`,
  ];
  if (opts.types && opts.types.length > 0) {
    conditions.push(inArray(inboxEvents.type, opts.types));
  }
  const picked = await tx
    .select({ id: inboxEvents.id })
    .from(inboxEvents)
    .where(and(...conditions))
    .orderBy(asc(inboxEvents.id))
    .limit(max)
    .for("update", { skipLocked: true });
  if (picked.length === 0) return [];
  const claimed = await tx
    .update(inboxEvents)
    .set({
      status: "injected",
      runTurnId: opts.runTurnId ?? null,
      injectedAt: new Date(),
    })
    .where(inArray(inboxEvents.id, picked.map((p) => p.id)))
    .returning();
  claimed.sort((a, b) => a.id - b.id);
  return claimed;
}

/**
 * THE claim primitive (§6.3), self-contained variant. PRECONDITION: the caller
 * holds the per-run lock for `runId` — both call sites (turn-boundary injection,
 * events__poll) run inside it. Wraps claimInboxEventsTx in its own transaction
 * for callers (events__poll) that only claim and do not also persist a frame in
 * the same commit; injectPendingInboxEvents drives claimInboxEventsTx directly
 * so the claim and the digest frame land atomically (§6.4).
 */
export async function claimInboxEvents(
  runId: number,
  opts: ClaimOptions = {}
): Promise<InboxEvent[]> {
  return db.transaction((tx) => claimInboxEventsTx(tx, runId, opts));
}

/** Stamp already-claimed events with the digest frame that carried them. Runs on
 *  the caller's transaction when one is supplied (§6.4 — same commit as the claim
 *  + frame insert), otherwise on the base connection. */
export async function setClaimTurn(
  eventIds: number[],
  runTurnId: number,
  executor: DbTx | typeof db = db
): Promise<void> {
  if (eventIds.length === 0) return;
  await executor
    .update(inboxEvents)
    .set({ runTurnId })
    .where(inArray(inboxEvents.id, eventIds));
}

/**
 * Platform-side acknowledgment for control events (§6.6): when enforcement
 * happens (abort, budget stop), mark the mirroring rows injected so the next
 * digest can show WHY the previous turn ended.
 */
export async function markControlInjected(runId: number, type: string): Promise<void> {
  await db
    .update(inboxEvents)
    .set({ status: "injected", injectedAt: new Date() })
    .where(
      and(
        eq(inboxEvents.targetRunId, runId),
        eq(inboxEvents.type, type),
        eq(inboxEvents.status, "pending")
      )
    );
}

/**
 * Control rows the platform already enforced (markControlInjected flipped
 * them pending→injected) but that no digest frame has rendered yet
 * (run_turn_id IS NULL). The digest builder includes these as "platform
 * notices" — this is how the next turn learns WHY the previous one ended —
 * and stamps them via setClaimTurn so they render exactly once. Kept out of
 * claimInboxEvents on purpose: control facts are enforced by the platform,
 * only their visibility flows through the digest.
 */
export async function takeUnrenderedControlEvents(
  runId: number,
  executor: DbTx | typeof db = db
): Promise<InboxEvent[]> {
  const rows = await executor
    .select()
    .from(inboxEvents)
    .where(
      and(
        eq(inboxEvents.targetRunId, runId),
        eq(inboxEvents.status, "injected"),
        sql`${inboxEvents.runTurnId} IS NULL`,
        inArray(inboxEvents.type, [...CONTROL_TYPES])
      )
    )
    .orderBy(asc(inboxEvents.id));
  return rows;
}

/** Quarantine a poison event (§6.5). Runs on the caller's transaction when one is
 *  supplied so a poison event claimed in the digest tx is marked 'error' in the
 *  same commit — the quarantine UPDATE never aborts the surrounding claim. */
export async function quarantineEvent(
  eventId: number,
  reason: string,
  executor: DbTx | typeof db = db
): Promise<void> {
  await executor
    .update(inboxEvents)
    .set({ status: "error", errorReason: reason.slice(0, 500) })
    .where(eq(inboxEvents.id, eventId));
}

/** Pending owner-audience count for a run (UI badges, wake decisions). */
export async function pendingOwnerCount(runId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxEvents)
    .where(
      and(
        eq(inboxEvents.targetRunId, runId),
        eq(inboxEvents.status, "pending"),
        eq(inboxEvents.audience, "owner")
      )
    );
  return rows[0]?.n ?? 0;
}

/**
 * Pending owner-audience counts for ALL runs in one grouped query — the /runs
 * index "N queued" badges (§11). Stays on the pending partial index, so cost
 * tracks the live backlog, not total event volume.
 */
export async function pendingOwnerCounts(): Promise<Map<number, number>> {
  const rows = await db
    .select({ runId: inboxEvents.targetRunId, n: sql<number>`count(*)::int` })
    .from(inboxEvents)
    .where(and(eq(inboxEvents.status, "pending"), eq(inboxEvents.audience, "owner")))
    .groupBy(inboxEvents.targetRunId);
  return new Map(rows.map((r) => [r.runId, r.n]));
}

/**
 * Recent inbox events addressed to a run, newest first — the run page's
 * traceability panel (§11). Read-only: every lifecycle state is included
 * (pending/injected/superseded/error) so the UI can show what a run saw,
 * what's queued, and what was quarantined or superseded.
 */
export async function listRunInboxEvents(runId: number, limit = 200): Promise<InboxEvent[]> {
  return db
    .select()
    .from(inboxEvents)
    .where(eq(inboxEvents.targetRunId, runId))
    .orderBy(desc(inboxEvents.id))
    .limit(Math.max(1, Math.min(limit, 500)));
}

/** A run's timers, newest first — rendered alongside the inbox so a parked
 *  run's "wake me in 45m" watchdog is visible and explainable. */
export async function listRunTimers(runId: number, limit = 50): Promise<RunTimer[]> {
  return db
    .select()
    .from(runTimers)
    .where(eq(runTimers.runId, runId))
    .orderBy(desc(runTimers.id))
    .limit(Math.max(1, Math.min(limit, 200)));
}

/**
 * Pump wake sweep (§6.2 belt): parked runs with pending owner-OR-supervisor
 * audience notify events (§5.2a — a supervisor copy's arrival wakes a parked
 * coordinator too). Bounded; the pending partial index keeps this cheap.
 */
export async function parkedRunsWithPendingEvents(limit = 50): Promise<number[]> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.status, "parked"),
        sql`EXISTS (SELECT 1 FROM ${inboxEvents}
              WHERE ${inboxEvents.targetRunId} = ${agentSessions.id}
                AND ${inboxEvents.status} = 'pending'
                AND ${inboxEvents.audience} IN ('owner', 'supervisor')
                AND ${inboxEvents.type} NOT IN (${sql.join(
                  [...CONTROL_TYPES].map((t) => sql`${t}`),
                  sql`, `
                )}))`
      )
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

// ────────────────────────────────────────
// Envelope (§2)
// ────────────────────────────────────────

export interface EventEnvelope {
  event_id: number;
  type: string;
  occurred_at: string;
  audience: Audience;
  source: { kind: string; id: string | null };
  attempt: number | null;
  correlation_id: string | null;
  causation_event_id: number | null;
  bubbled_from: number | null;
  payload: unknown;
}

/** Render a row to the uniform envelope; throws on poison (caller
 *  quarantines via quarantineEvent — §6.5). */
export function toEnvelope(row: InboxEvent): EventEnvelope {
  const serialized = JSON.stringify(row.payload ?? {});
  // Byte length, not string length: .length counts UTF-16 code units, which
  // undercounts multi-byte UTF-8 payloads against a byte cap.
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return {
    event_id: row.id,
    type: row.type,
    occurred_at: row.createdAt.toISOString(),
    audience: (row.audience as Audience) ?? "owner",
    source: { kind: row.sourceKind, id: row.sourceId },
    attempt: row.attempt,
    correlation_id: row.correlationId,
    causation_event_id: row.causationEventId,
    bubbled_from: row.bubbledFrom,
    payload: row.payload ?? {},
  };
}

// ────────────────────────────────────────
// Timers (§7)
// ────────────────────────────────────────

export const TIMER_MIN_MINUTES = 1;
export const TIMER_MAX_MINUTES = 1440; // 24h
export const TIMER_MAX_PER_RUN = 4;
export const TIMER_MAX_PER_TREE = 64;

export interface CreateTimerInput {
  runId: number;
  minutes: number;
  note?: string | null;
  correlationId?: string | null;
}

export type CreateTimerResult =
  | { ok: true; timerId: number; fireAt: Date }
  | { ok: false; error: string };

/**
 * Count pending timers across the whole tree the run belongs to: walk up
 * parent_run_id to the root (depth-capped), then a recursive CTE over the
 * subtree. Enforces TIMER_MAX_PER_TREE so a runaway fan-out can't arm
 * thousands of timers one under-cap run at a time.
 */
async function pendingTreeTimerCount(runId: number): Promise<number> {
  // Upward walk to the root (parent chains are depth-capped at spawn time).
  let rootId = runId;
  const seen = new Set<number>();
  for (let i = 0; i < 16; i++) {
    if (seen.has(rootId)) break;
    seen.add(rootId);
    const row = (
      await db
        .select({ parentRunId: agentSessions.parentRunId })
        .from(agentSessions)
        .where(eq(agentSessions.id, rootId))
    )[0];
    if (!row || row.parentRunId == null) break;
    rootId = row.parentRunId;
  }
  const rows = (await db.execute(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM ${agentSessions} WHERE id = ${rootId}
      UNION ALL
      SELECT a.id FROM ${agentSessions} a JOIN tree t ON a.parent_run_id = t.id
    )
    SELECT count(*)::int AS n FROM ${runTimers}
     WHERE status = 'pending' AND run_id IN (SELECT id FROM tree)
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export async function createTimer(input: CreateTimerInput): Promise<CreateTimerResult> {
  const minutes = Math.max(TIMER_MIN_MINUTES, Math.min(Math.floor(input.minutes), TIMER_MAX_MINUTES));
  const pending = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runTimers)
    .where(and(eq(runTimers.runId, input.runId), eq(runTimers.status, "pending")));
  if ((pending[0]?.n ?? 0) >= TIMER_MAX_PER_RUN) {
    return {
      ok: false,
      error: `Timer cap: this run already has ${TIMER_MAX_PER_RUN} pending timers. Cancel one (timer__cancel) first.`,
    };
  }
  if ((await pendingTreeTimerCount(input.runId)) >= TIMER_MAX_PER_TREE) {
    return {
      ok: false,
      error: `Timer cap: this run tree already has ${TIMER_MAX_PER_TREE} pending timers across all runs. Cancel timers or let some fire first.`,
    };
  }
  const fireAt = new Date(Date.now() + minutes * 60_000);
  const rows = await db
    .insert(runTimers)
    .values({
      runId: input.runId,
      fireAt,
      note: input.note ?? null,
      correlationId: input.correlationId ?? null,
    })
    .returning({ id: runTimers.id });
  return { ok: true, timerId: rows[0].id, fireAt };
}

export async function cancelTimer(runId: number, timerId: number): Promise<boolean> {
  const res = await db
    .update(runTimers)
    .set({ status: "cancelled" })
    .where(
      and(eq(runTimers.id, timerId), eq(runTimers.runId, runId), eq(runTimers.status, "pending"))
    );
  return (res as unknown as { count?: number }).count !== 0;
}

/**
 * Cancel a run's still-pending timers that carry a given correlationId. Used to
 * defuse the await_session backstop (correlationId `await-session:<child>`): when
 * the awaited child emits its terminal event the parent no longer needs the
 * timeout timer, which would otherwise fire a spurious `timer.fired` later.
 * Returns the number cancelled.
 */
export async function cancelTimersByCorrelation(
  runId: number,
  correlationId: string
): Promise<number> {
  const rows = await db
    .update(runTimers)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(runTimers.runId, runId),
        eq(runTimers.status, "pending"),
        eq(runTimers.correlationId, correlationId)
      )
    )
    .returning({ id: runTimers.id });
  return rows.length;
}

/** Cancel all still-pending timers owned by a run. Terminal/closed runs cannot
 * consume timer.fired events, so pending watchdogs should not survive them. */
export async function cancelPendingTimersForRun(runId: number): Promise<number> {
  const rows = await db
    .update(runTimers)
    .set({ status: "cancelled" })
    .where(and(eq(runTimers.runId, runId), eq(runTimers.status, "pending")))
    .returning({ id: runTimers.id });
  return rows.length;
}

/**
 * Fire due timers (pump tick, §7). Atomic claim across concurrent pumps via
 * the conditional UPDATE; each fired timer becomes a `timer.fired` inbox
 * event with dedupe key `timer:<id>` — at-least-once, late after downtime,
 * never lost. Returns the number fired.
 */
export async function fireDueTimers(now = new Date()): Promise<number> {
  const due = await db
    .update(runTimers)
    .set({ status: "fired", firedAt: now })
    .where(and(eq(runTimers.status, "pending"), sql`${runTimers.fireAt} <= ${now}`))
    .returning();
  for (const t of due) {
    await emitInboxEvent({
      targetRunId: t.runId,
      type: "timer.fired",
      sourceKind: "timer",
      sourceId: String(t.id),
      correlationId: t.correlationId,
      dedupeKey: `timer:${t.id}`,
      payload: {
        timer_id: t.id,
        note: t.note,
        set_at: t.createdAt.toISOString(),
        fire_at: t.fireAt.toISOString(),
      },
    }).catch(() => {});
  }
  return due.length;
}
