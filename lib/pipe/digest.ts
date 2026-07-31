// lib/pipe/digest.ts
//
// The `/status` digest (PRD J3). "What's in flight?" answered from LIVE STATE,
// with no model call at all: this is a DB query and a formatter, which is what
// makes the PRD's "< 5 s digest latency" metric trivially true and what keeps a
// status check from costing a turn.
//
// Shape rules, straight out of J3 and §8:
//   • blocked-ON-USER first — the queue is theirs, so their items lead;
//   • at most MAX_LINES lines, then "N more…" (progressive disclosure);
//   • exactly ONE next action per line, so a line is actionable on a phone;
//   • every task / plan / run / PR id carries a deep link (lib/pipe/links.ts).
//
// SCOPE. The digest is conversation-scoped in the sense that the persona is the
// one answering, but the interesting runs are almost never the conversation's
// own `<chat>` run — they are the children it spawned, plus anything else this
// persona or this user has going. So the query is:
//
//   non-terminal runs, goal != '<chat>', WHERE persona_id = <this persona>
//   OR user_id = <the linked user, when the asker has linked one>
//
// An unlinked asker therefore sees the persona's work (which is by definition
// the work they are talking to it about) and nothing personal; a linked asker
// also sees their own runs started elsewhere (the web UI, another persona).

import { and, eq, inArray, isNotNull, ne, notInArray, or, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { agentSessions, tasks } from "@/db/schema";
import { TERMINAL_STATUSES } from "@/lib/run-state";

import { planLink, runLabel, runLink, runsLink, taskLink } from "./links";

/** Lines shown before the digest collapses into "N more…" (PRD J3). */
export const MAX_LINES = 5;

/** One in-flight item, already classified and ordered. */
export interface DigestItem {
  runId: number;
  label: string;
  glyph: string;
  /** The single next action for this line. */
  action: string;
  /** Deep links appended to the line, in order. */
  links: string[];
  /** True when the item is waiting on the human — these sort first. */
  blockedOnUser: boolean;
  startedAt: Date;
}

interface DigestRunRow {
  id: number;
  goal: string;
  title: string | null;
  taskId: string | null;
  planId: string | null;
  status: string;
  parkReason: string | null;
  /** `unknown` in the schema (jsonb); only its presence and first line matter. */
  pendingQuestion: unknown;
  prUrl: string | null;
  startedAt: Date;
}

/**
 * The pending question on a run, in its real shape (lib/run-state.ts
 * PendingQuestion: `{ question_id, question, state, … }`). Tolerates the bare
 * string an older writer might have left, and returns null for anything else.
 */
function pendingQuestionOf(
  raw: unknown
): { question: string | null; state: string } | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    return text ? { question: text, state: "open" } : null;
  }
  if (typeof raw !== "object") return null;
  const q = raw as { question?: unknown; state?: unknown };
  return {
    question: typeof q.question === "string" && q.question.trim() ? q.question.trim() : null,
    // A row with no state is an open question by construction: `state` is only
    // ever written as part of asking, and only ever moved off "open" by an
    // answer or an expiry.
    state: typeof q.state === "string" ? q.state : "open",
  };
}

/**
 * A run is blocked on the human when it left an OPEN `pending_question`, or
 * parked with `park_reason = 'question'` and nothing has answered it
 * (docs/agent-events.md §6.1).
 *
 * The state check matters: answer_question (lib/extensions/events.ts) settles a
 * question by writing `state: 'answered'` in place — it does NOT null the column
 * or clear `park_reason` — so a digest that only tested for presence kept
 * reporting answered questions as "needs your call" forever.
 */
function isBlockedOnUser(r: DigestRunRow): boolean {
  const q = pendingQuestionOf(r.pendingQuestion);
  if (q) return q.state === "open";
  return r.parkReason === "question";
}

/** Classify one run into the glyph + one next action the digest line shows. */
export function classify(r: DigestRunRow): DigestItem {
  const links: string[] = [];
  if (r.taskId) links.push(taskLink(r.taskId));
  else if (r.planId) links.push(planLink(r.planId));
  links.push(r.prUrl ?? runLink(r.id));

  const base = {
    runId: r.id,
    label: runLabel(r),
    links,
    startedAt: r.startedAt,
  };

  if (isBlockedOnUser(r)) {
    const q = pendingQuestionOf(r.pendingQuestion)?.question?.split("\n")[0].trim() || undefined;
    return {
      ...base,
      glyph: "🚧",
      blockedOnUser: true,
      action: q ? `needs your call: ${truncate(q, 90)} ← reply here` : "blocked on you ← reply here",
    };
  }
  if (r.prUrl) {
    return { ...base, glyph: "🔍", blockedOnUser: false, action: "PR open — awaiting review" };
  }
  if (r.status === "parked") {
    return { ...base, glyph: "⏳", blockedOnUser: false, action: "parked, waiting on an event" };
  }
  if (r.status === "pending") {
    return { ...base, glyph: "⏳", blockedOnUser: false, action: "queued to start" };
  }
  return { ...base, glyph: "⏳", blockedOnUser: false, action: "working" };
}

/**
 * Order: blocked-on-user first, then OLDEST first inside each group. Oldest
 * first is deliberate — a question that has been sitting for two days is more
 * urgent than one asked a minute ago, and the digest truncates at MAX_LINES.
 */
export function orderItems(items: DigestItem[]): DigestItem[] {
  return [...items].sort((a, b) => {
    if (a.blockedOnUser !== b.blockedOnUser) return a.blockedOnUser ? -1 : 1;
    return a.startedAt.getTime() - b.startedAt.getTime();
  });
}

/**
 * Render the digest body from ordered items (pure; the formatter under test).
 *
 * SHAPE (PRD J3): a header, at most MAX_LINES item lines, then ONE trailing
 * summary line. Everything that is not an item — the "…and N more" link, the
 * todo-task counts, the caller's footer (the /status thread-liveness line) —
 * is folded into that single trailing line, so the message stays the ~5-lines-
 * then-summarize shape a phone can read rather than growing a line per fact.
 */
export function renderDigest(
  items: DigestItem[],
  todo?: { tasks: number; plans: number },
  footer?: string
): string {
  const lines: string[] = [];
  const tail: string[] = [];
  if (items.length === 0) {
    lines.push("**Nothing in flight.**");
  } else {
    lines.push(`**In flight (${items.length}):**`);
    for (const it of items.slice(0, MAX_LINES)) {
      lines.push(`${it.glyph} ${it.label} — ${it.action} · ${it.links.join(" · ")}`);
    }
    if (items.length > MAX_LINES) {
      // The link goes to the runs OVERVIEW: "3 more" is about the ones NOT
      // shown, so pointing at the first one that IS shown was a dead end.
      tail.push(`…and ${items.length - MAX_LINES} more — all runs: ${runsLink()}`);
    }
  }
  if (todo && todo.tasks > 0) {
    tail.push(
      `${todo.tasks} task${todo.tasks === 1 ? "" : "s"} todo across ` +
        `${todo.plans} plan${todo.plans === 1 ? "" : "s"}.`
    );
  }
  if (footer) tail.push(footer);
  if (tail.length) lines.push(tail.join(" · "));
  return lines.join("\n");
}

/** Fetch + classify + order the in-flight runs for a persona (and user). */
export async function collectItems(personaId: string, userId: number | null): Promise<DigestItem[]> {
  const scope: SQL | undefined =
    userId == null
      ? eq(agentSessions.personaId, personaId)
      : or(eq(agentSessions.personaId, personaId), eq(agentSessions.userId, userId));

  const rows = await db
    .select({
      id: agentSessions.id,
      goal: agentSessions.goal,
      title: agentSessions.title,
      taskId: agentSessions.taskId,
      planId: agentSessions.planId,
      status: agentSessions.status,
      parkReason: agentSessions.parkReason,
      pendingQuestion: agentSessions.pendingQuestion,
      prUrl: agentSessions.prUrl,
      startedAt: agentSessions.startedAt,
    })
    .from(agentSessions)
    .where(
      and(
        // '<chat>' runs are the persona CONVERSATIONS themselves (this thread
        // and its siblings). They are always "in flight" in the sense of being
        // resumable, and listing them would bury the actual work.
        ne(agentSessions.goal, "<chat>"),
        notInArray(agentSessions.status, TERMINAL_STATUSES),
        scope
      )
    );

  return orderItems(rows.map(classify));
}

/** Todo-task footer counts (PRD J3's trailing "12 tasks todo across 2 plans"). */
async function todoCounts(): Promise<{ tasks: number; plans: number }> {
  const rows = await db
    .select({ planId: tasks.planId })
    .from(tasks)
    .where(and(eq(tasks.state, "todo"), isNotNull(tasks.planId)));
  return { tasks: rows.length, plans: new Set(rows.map((r) => r.planId)).size };
}

/**
 * The whole `/status` answer. No model call, no agent turn — commands.ts calls
 * this and sends the string.
 */
export async function buildStatusDigest(
  personaId: string,
  userId: number | null,
  /** Folded into the digest's trailing line (the /status thread-liveness note). */
  footer?: string
): Promise<string> {
  const [items, todo] = await Promise.all([collectItems(personaId, userId), todoCounts()]);
  return renderDigest(items, todo, footer);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Kept for callers that want to restrict the digest to an explicit run set
// (Milestone 6's per-thread digest); unused today but the query shape is the
// same, so it lives with its siblings rather than being reinvented later.
export async function collectItemsForRuns(runIds: number[]): Promise<DigestItem[]> {
  if (runIds.length === 0) return [];
  const rows = await db
    .select({
      id: agentSessions.id,
      goal: agentSessions.goal,
      title: agentSessions.title,
      taskId: agentSessions.taskId,
      planId: agentSessions.planId,
      status: agentSessions.status,
      parkReason: agentSessions.parkReason,
      pendingQuestion: agentSessions.pendingQuestion,
      prUrl: agentSessions.prUrl,
      startedAt: agentSessions.startedAt,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.id, runIds));
  return orderItems(rows.map(classify));
}
