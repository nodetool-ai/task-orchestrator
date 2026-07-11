// lib/extensions/events.ts
//
// Always-on tools for the agent event system (docs/agent-events.md). Mounted
// outside the profile system (lib/profiles.ts `alwaysOnExtensions`) so every
// run, in every tools profile, has a way to sleep, poll, emit/receive
// custom events, report a structured result, raise a structured exception,
// and hold a stateful child<->parent question exchange.
//
// EXECUTION MODEL: the tool definitions live in EVENT_TOOLS (server-executable
// registry entries, resolved by lib/worker/server-tools). The extension
// factory registers thin wrappers that route through the worker transport —
// in-process on the orchestrator, POST /api/worker/runs/:id/tools/call from an
// HTTP worker. Workers hold no database access (hard requirement), so nothing
// in the execute bodies may run worker-side.
//
// CONTRACT WITH lib/runs.ts (the turn-end handler): tools registered here
// NEVER set agent_runs.status directly. They write mutable columns only
// (park_reason / result / pending_question), and the turn-end handler maps
// those to a landing status. The contract, the column semantics, and the typed
// TurnEffect writer (recordTurnEffect) now live in lib/run-state.ts — its module
// header is the single home for the documentation. These tools express their
// intent as a TurnEffect and funnel every column write through recordTurnEffect.
//
// Pure helpers are exported for direct unit testing without DB setup.

import { Type } from "typebox";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, runTimers } from "@/db/schema";
import * as runs from "../runs";
import * as runDispatch from "../run-dispatch";
import {
  CONTROL_TYPES,
  TIMER_MAX_MINUTES,
  TIMER_MIN_MINUTES,
  cancelTimer,
  claimInboxEvents,
  createTimer,
  emitInboxEvent,
  pendingOwnerCount,
  quarantineEvent,
  toEnvelope,
  type Audience,
} from "../inbox";
import type { OrchestratorTool, OrchestratorToolResult } from "../orchestrator-tools";
import { runTransport } from "@/lib/worker";
import type { ExtensionFactory } from "./types";
import { recordTurnEffect } from "../run-state";
import type {
  PendingQuestion,
  ResultReport,
  ResultException,
  TurnEffectColumns,
} from "../run-state";

/** Patch mutable agent_runs columns for `runId` — the single write path the
 *  parking-contract tools hand to recordTurnEffect (see lib/run-state.ts). */
const patchRunColumns =
  (runId: number) =>
  (columns: TurnEffectColumns): Promise<unknown> =>
    db.update(agentSessions).set(columns).where(eq(agentSessions.id, runId));

const ok = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
});
const errResult = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

// ────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ────────────────────────────────────────

// PendingQuestion moved to lib/run-state.ts (the parking-contract owner);
// re-exported here so existing `lib/extensions/events` importers keep working.
export type { PendingQuestion };

/**
 * Pure validator for answer_question's state-machine gate (§8): can THIS
 * question_id be answered right now, given the child's current
 * pending_question column? Returns null when answerable, or the exact error
 * message to surface otherwise.
 */
export function checkAnswerable(
  pendingQuestion: PendingQuestion | null | undefined,
  questionId: string
): string | null {
  if (!pendingQuestion || pendingQuestion.question_id !== questionId) {
    return `No open question '${questionId}' found on this run (pending_question is ${
      pendingQuestion ? `for '${pendingQuestion.question_id}'` : "empty"
    }).`;
  }
  if (pendingQuestion.state === "answered") {
    return `Question '${questionId}' was already answered at ${
      pendingQuestion.answered_at ?? "an unknown time"
    }.`;
  }
  if (pendingQuestion.state === "expired") {
    const assumption = pendingQuestion.assumption
      ? ` The child proceeded on assumption: ${pendingQuestion.assumption}`
      : "";
    return `Question '${questionId}' already expired (its deadline passed before an answer arrived).${assumption}`;
  }
  if (pendingQuestion.state !== "open") {
    return `Question '${questionId}' is not open (state='${pendingQuestion.state}').`;
  }
  return null;
}

/**
 * Pure guard for events__emit (§3.6): custom events are the only type an
 * agent may emit directly — everything else in the taxonomy is produced by
 * platform code, and letting agents forge e.g. 'child.result' would defeat
 * the result contract (§4).
 */
export function checkCustomEventType(type: string): string | null {
  if (!type.startsWith("custom.")) {
    return `events__emit only accepts types prefixed 'custom.' (got '${type}'). Platform event types (child.*, gh.*, timer.*, task.*, ...) are produced by the system, not emitted directly.`;
  }
  if (CONTROL_TYPES.has(type)) {
    // Not reachable while the prefix is enforced (CONTROL_TYPES has no
    // 'custom.' members today), but keep the guard explicit and future-proof.
    return `'${type}' is a control-class event and cannot be emitted by a tool.`;
  }
  return null;
}

/**
 * Pure tree-membership check (§3.6): events__emit may only target a run
 * that shares the caller's tree root. Takes precomputed root ids so the DB
 * walk stays outside the pure/testable core.
 */
export function isWithinCallerTree(callerRootId: number, targetRootId: number): boolean {
  return callerRootId === targetRootId;
}

// ────────────────────────────────────────
// DB-backed helpers (server-side only)
// ────────────────────────────────────────

const MAX_WALK = 64;

/** Walk parent_run_id upward to the root of the tree containing `startId`. */
async function findRootId(startId: number): Promise<number> {
  let id = startId;
  const seen = new Set<number>();
  for (let i = 0; i < MAX_WALK; i++) {
    if (seen.has(id)) break;
    seen.add(id);
    const row = (
      await db
        .select({ parentRunId: agentSessions.parentRunId })
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
    )[0];
    if (!row || row.parentRunId == null) break;
    id = row.parentRunId;
  }
  return id;
}

interface RawRunFields {
  id: number;
  status: string;
  parentRunId: number | null;
  attempt: number;
  pendingQuestion: PendingQuestion | null;
}

async function getRawRunFields(id: number): Promise<RawRunFields | null> {
  const row = (
    await db
      .select({
        id: agentSessions.id,
        status: agentSessions.status,
        parentRunId: agentSessions.parentRunId,
        attempt: agentSessions.attempt,
        pendingQuestion: agentSessions.pendingQuestion,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
  )[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    parentRunId: row.parentRunId,
    attempt: row.attempt,
    pendingQuestion: (row.pendingQuestion as PendingQuestion | null) ?? null,
  };
}

/**
 * Deliver a message to a run without ending the CALLER's turn: the exact
 * fire-and-forget mechanism spawn__append_message uses in lib/extensions/spawn.ts
 * (sendMessageToRun over the remote runner; runs.append raced against a
 * setImmediate tick for the in-process dev path). Best-effort — errors are
 * swallowed into the returned string so answer_question's own bookkeeping
 * (state=answered, timer cancelled) already committed either way.
 */
async function deliverMessage(targetRunId: number, text: string): Promise<string | null> {
  if (runDispatch.remoteRunnerEnabled()) {
    const relayAbort = new AbortController();
    const gen = runs.sendMessageToRun({ runId: targetRunId, role: "user", text, abort: relayAbort });
    try {
      const first = await gen.next();
      if (!first.done && first.value?.type === "error") {
        return first.value.error ?? "append failed";
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      relayAbort.abort();
      await gen.return(undefined).catch(() => {});
    }
  }

  // In-process (dev / non-remote) mode: float the drain, racing one
  // setImmediate tick so a synchronously-failing append surfaces as an error.
  let appendError: string | null = null;
  const drain = (async () => {
    try {
      for await (const event of runs.append({ runId: targetRunId, role: "user", text })) {
        if (event.type === "error") appendError = event.error ?? "append failed";
        if (event.type === "done" || event.type === "error") break;
      }
    } catch (err) {
      appendError = err instanceof Error ? err.message : String(err);
    }
  })();
  await Promise.race([drain, new Promise<void>((res) => setImmediate(res))]);
  return appendError;
}

/** The caller run id every event tool needs; a missing one is a miswired mount. */
function requireRunId(ctx: { runId?: number }): number | null {
  return typeof ctx.runId === "number" && ctx.runId > 0 ? ctx.runId : null;
}

const NO_RUN = errResult(
  "Event tools need a caller run context (mounted without a run id — this is a bug in the mount, not your call)."
);

// ────────────────────────────────────────
// Server-executable tool registry
// ────────────────────────────────────────

export const EVENT_TOOLS: OrchestratorTool[] = [
  {
    name: "timer__sleep",
    label: "Sleep",
    description:
      "Park this run and go to sleep for up to `minutes` (clamped to " +
      `[${TIMER_MIN_MINUTES}, ${TIMER_MAX_MINUTES}]). ` +
      "Wakes on the timer firing OR on any earlier owner-audience inbox event " +
      "(sleep is a maximum wait, not a hard suspension). Always available in " +
      "every tools profile — this is the platform's guaranteed way to yield.",
    parameters: Type.Object({
      minutes: Type.Integer({ minimum: TIMER_MIN_MINUTES, maximum: TIMER_MAX_MINUTES }),
      note: Type.Optional(Type.String()),
    }),
    execute: async ({ minutes, note }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const res = await createTimer({ runId, minutes, note: note ?? null, correlationId: null });
      if (!res.ok) return errResult(res.error);
      await recordTurnEffect(patchRunColumns(runId), { kind: "park", reason: "sleeping" });
      return ok(
        `Timer #${res.timerId} armed, firing at ${res.fireAt.toISOString()}. ` +
          `End your turn now — you will be woken by this timer or by any earlier event.`
      );
    },
  },

  {
    name: "timer__set",
    label: "Set Timer",
    description:
      "Schedule a future timer.fired event WITHOUT parking. How an agent arms a " +
      "watchdog for its own children ('wake me in 45 minutes even if nothing has " +
      "happened'). Multiple may be armed, up to the per-run/per-tree caps.",
    parameters: Type.Object({
      minutes: Type.Integer({ minimum: TIMER_MIN_MINUTES, maximum: TIMER_MAX_MINUTES }),
      note: Type.Optional(Type.String()),
    }),
    execute: async ({ minutes, note }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const res = await createTimer({ runId, minutes, note: note ?? null, correlationId: null });
      if (!res.ok) return errResult(res.error);
      return ok(
        JSON.stringify({ timer_id: res.timerId, fire_at: res.fireAt.toISOString() }, null, 2)
      );
    },
  },

  {
    name: "timer__cancel",
    label: "Cancel Timer",
    description: "Cancel a pending timer you own by id.",
    parameters: Type.Object({ timer_id: Type.Integer({ minimum: 1 }) }),
    execute: async ({ timer_id }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const cancelled = await cancelTimer(runId, timer_id);
      if (!cancelled) {
        return errResult(
          `Timer #${timer_id} not found, not owned by this run, or already fired/cancelled.`
        );
      }
      return ok(`Timer #${timer_id} cancelled.`);
    },
  },

  {
    name: "events__poll",
    label: "Poll Events",
    description:
      "Non-blocking check for inbox events that arrived since your last turn or " +
      "digest, without ending your turn. Owner events (yours to act on) are " +
      "returned first, then a separate supervisor section (informational copies " +
      "for your awareness only). Control-class events (cancel/budget) are never " +
      "returned here — the platform enforces those directly.",
    parameters: Type.Object({
      types: Type.Optional(Type.Array(Type.String())),
      max: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    execute: async ({ types, max }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const claimed = await claimInboxEvents(runId, {
        audiences: ["owner", "supervisor"] as Audience[],
        types,
        max,
      });
      const owner: unknown[] = [];
      const supervisor: unknown[] = [];
      for (const row of claimed) {
        try {
          const env = toEnvelope(row);
          (env.audience === "supervisor" ? supervisor : owner).push(env);
        } catch (err) {
          await quarantineEvent(row.id, err instanceof Error ? err.message : String(err)).catch(
            () => {}
          );
        }
      }
      const remaining = await pendingOwnerCount(runId).catch(() => 0);
      const pending_note =
        remaining > 0
          ? `${remaining} more owner-audience event(s) still pending (raise \`max\` or poll again).`
          : null;
      return ok(
        JSON.stringify(
          { events: [...owner, ...supervisor], owner, supervisor, pending_note },
          null,
          2
        )
      );
    },
  },

  {
    name: "events__emit",
    label: "Emit Custom Event",
    description:
      "Emit a custom.* event to another run WITHIN YOUR OWN TREE (same root). " +
      "The sibling-coordination escape hatch — e.g. tell a sibling implementor " +
      "'the shared interface changed' — without a general cross-tree messaging " +
      "surface. `type` must start with 'custom.'.",
    parameters: Type.Object({
      target_run_id: Type.Integer({ minimum: 1 }),
      type: Type.String({ minLength: 1 }),
      payload: Type.Optional(Type.Record(Type.String(), Type.Any())),
      correlation_id: Type.Optional(Type.String()),
    }),
    execute: async ({ target_run_id, type, payload, correlation_id }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const typeError = checkCustomEventType(type);
      if (typeError) return errResult(typeError);

      const target = await getRawRunFields(target_run_id);
      if (!target) return errResult(`Run ${target_run_id} not found.`);

      const [callerRoot, targetRoot] = await Promise.all([
        findRootId(runId),
        findRootId(target_run_id),
      ]);
      if (!isWithinCallerTree(callerRoot, targetRoot)) {
        return errResult(
          `Run ${target_run_id} is outside your tree (root #${targetRoot} vs your root #${callerRoot}). ` +
            `events__emit only reaches runs within the caller's own tree.`
        );
      }

      const result = await emitInboxEvent({
        targetRunId: target_run_id,
        type,
        payload: payload ?? {},
        sourceKind: "user",
        sourceId: String(runId),
        correlationId: correlation_id ?? null,
      });
      return ok(
        JSON.stringify(
          {
            event_id: result.eventId,
            target_run_id: result.targetRunId,
            woke: result.woke,
          },
          null,
          2
        )
      );
    },
  },

  {
    name: "report_result",
    label: "Report Result",
    description:
      "Report this run's final result. Persists the result to agent_runs.result " +
      "— it does NOT set run status or emit anything itself; the turn-end handler " +
      "maps this column to a terminal status and emits child.result to the parent. " +
      "This is the expected end of a child run's work.",
    parameters: Type.Object({
      status: Type.Union([
        Type.Literal("success"),
        Type.Literal("failed"),
        Type.Literal("blocked"),
      ]),
      summary: Type.String({ minLength: 1, maxLength: 2000 }),
      data: Type.Optional(Type.Record(Type.String(), Type.Any())),
      pr_url: Type.Optional(Type.String()),
      needs: Type.Optional(Type.String()),
    }),
    execute: async ({ status, summary, data, pr_url, needs }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const payload: ResultReport = {
        kind: "result",
        status,
        summary,
        data: data ?? null,
        pr_url: pr_url ?? null,
        needs: needs ?? null,
        reported_at: new Date().toISOString(),
      };
      await recordTurnEffect(patchRunColumns(runId), {
        kind: "result",
        payload,
        resultKind: "result",
      });
      return ok("Result recorded. End your turn now — this is your final report.");
    },
  },

  {
    name: "raise",
    label: "Raise Exception",
    description:
      "Report a named exception this run hit. Persists to agent_runs.result " +
      "(kind='exception') — it does NOT set run status or emit anything itself; " +
      "the turn-end handler maps this to a terminal status and emits " +
      "child.exception to the parent. `recoverable: true` signals that " +
      "spawn__append_message on this run is a sensible fix path.",
    parameters: Type.Object({
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      recoverable: Type.Boolean(),
      details: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    execute: async ({ code, message, recoverable, details }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const payload: ResultException = {
        kind: "exception",
        code,
        message,
        recoverable,
        details: details ?? null,
        raised_at: new Date().toISOString(),
      };
      await recordTurnEffect(patchRunColumns(runId), {
        kind: "result",
        payload,
        resultKind: "exception",
      });
      return ok("Exception recorded. End your turn now.");
    },
  },

  {
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask your parent run a question and park until it's answered or the " +
      "deadline passes. Roots with no parent get an error telling them to ask " +
      "the human instead.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }),
      context: Type.Optional(Type.Record(Type.String(), Type.Any())),
      timeout_minutes: Type.Optional(
        Type.Integer({ minimum: TIMER_MIN_MINUTES, maximum: TIMER_MAX_MINUTES, default: 60 })
      ),
    }),
    execute: async ({ question, context, timeout_minutes }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const self = await getRawRunFields(runId);
      if (!self) return errResult(`Run ${runId} not found.`);
      if (self.parentRunId == null) {
        return errResult(
          "This is a root run with no parent; ask_parent has no one to ask. Surface the question to the human instead (e.g. via report_result status='blocked')."
        );
      }
      const minutes = timeout_minutes ?? 60;
      const attempt = self.attempt ?? 1;

      const questionId = `q-${runId}-${Date.now()}`;
      const askedAt = new Date();
      const deadline = new Date(askedAt.getTime() + minutes * 60_000);
      const pendingQuestion: PendingQuestion = {
        question_id: questionId,
        question,
        context: context ?? null,
        asked_at: askedAt.toISOString(),
        deadline: deadline.toISOString(),
        state: "open",
      };

      // Arm the deadline timer BEFORE parking. If the timer cap is hit we bail
      // out here without recording the question, so the child never parks with
      // no automatic expiry and no parent notification (which would strand it
      // until a human intervenes).
      const timerRes = await createTimer({
        runId,
        minutes,
        note: "ask_parent deadline",
        correlationId: questionId,
      });
      if (!timerRes.ok) {
        return errResult(
          `Could not arm the ${minutes}m deadline timer: ${timerRes.error}. Question not sent; retry or ask fewer questions concurrently.`
        );
      }

      await recordTurnEffect(patchRunColumns(runId), { kind: "question", question: pendingQuestion });

      await emitInboxEvent({
        targetRunId: self.parentRunId,
        type: "child.question",
        sourceKind: "run",
        sourceId: String(runId),
        correlationId: questionId,
        attempt,
        payload: {
          run_id: runId,
          question_id: questionId,
          question,
          context: context ?? null,
        },
      });

      return ok(
        `Question sent (id ${questionId}). End your turn now; you'll wake with the answer or at the deadline (${deadline.toISOString()}).`
      );
    },
  },

  {
    name: "answer_question",
    label: "Answer Question",
    description:
      "Answer a child's pending ask_parent question. First answer wins; a second " +
      "call for the same question_id errors ('already answered'), and an answer " +
      "arriving after the child's deadline fired errors with the child's recorded " +
      "assumption (if any) so you know it proceeded without your input.",
    parameters: Type.Object({
      child_run_id: Type.Integer({ minimum: 1 }),
      question_id: Type.String({ minLength: 1 }),
      answer: Type.String({ minLength: 1 }),
    }),
    execute: async ({ child_run_id, question_id, answer }, ctx) => {
      const runId = requireRunId(ctx);
      if (!runId) return NO_RUN;
      const child = await getRawRunFields(child_run_id);
      if (!child) return errResult(`Run ${child_run_id} not found.`);

      const gateError = checkAnswerable(child.pendingQuestion, question_id);
      if (gateError) return errResult(gateError);

      const answeredAt = new Date().toISOString();
      const updated: PendingQuestion = {
        ...(child.pendingQuestion as PendingQuestion),
        state: "answered",
        answered_at: answeredAt,
      };
      // Conditional write: checkAnswerable above is a read-then-write race —
      // two concurrent answers (or a retried tool call) could both pass the
      // gate. Guard the UPDATE on the question still being open so exactly one
      // answer wins and the loser gets the documented "already answered" error.
      const claimed = await db
        .update(agentSessions)
        .set({ pendingQuestion: updated })
        .where(
          and(
            eq(agentSessions.id, child_run_id),
            sql`${agentSessions.pendingQuestion}->>'question_id' = ${question_id}`,
            sql`${agentSessions.pendingQuestion}->>'state' = 'open'`
          )
        )
        .returning({ id: agentSessions.id });
      if (claimed.length === 0) {
        return errResult(`Question '${question_id}' was already answered.`);
      }

      // Cancel the child's deadline timer (correlated by question_id).
      const timerRow = (
        await db
          .select({ id: runTimers.id })
          .from(runTimers)
          .where(
            and(
              eq(runTimers.runId, child_run_id),
              eq(runTimers.correlationId, question_id),
              eq(runTimers.status, "pending")
            )
          )
      )[0];
      if (timerRow) {
        await cancelTimer(child_run_id, timerRow.id).catch(() => {});
      }

      const deliverError = await deliverMessage(
        child_run_id,
        `[answer to question ${question_id}] ${answer}`
      );
      if (deliverError) {
        return errResult(
          `Answer recorded, but delivery to run ${child_run_id} failed: ${deliverError}`
        );
      }
      return ok(`Answer delivered to run ${child_run_id} for question ${question_id}.`);
    },
  },
];

// ────────────────────────────────────────
// Extension factory (transport-backed wrappers)
// ────────────────────────────────────────

export interface EventsExtensionOptions {
  runId: number;
}

export const eventsExtension =
  ({ runId }: EventsExtensionOptions): ExtensionFactory =>
  (reg) => {
    for (const tool of EVENT_TOOLS) {
      reg.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, params) => {
          const transport = await runTransport();
          const r = await transport.callTool(runId, tool.name, params, { author: "agent" });
          return { content: r.content, details: undefined, isError: r.isError ?? false };
        },
      });
    }
  };
