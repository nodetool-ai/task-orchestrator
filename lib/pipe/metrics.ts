// lib/pipe/metrics.ts
//
// The PRD §11 success metrics for the messaging surface, on the project's
// existing metrics surface: prom-client counters/histograms registered into the
// SAME registry `GET /api/metrics` serves (lib/runner/telemetry.ts), in the same
// style — a lazily built state object on globalThis, no new dependencies.
//
// NOT instrumented (deliberately): PRD §11's "unprompted-message tolerance"
// (mute/leave/allowlist-removal events) — Discord surfaces none of these to the
// bot without extra privileged intents; revisit if the guild-members intent is
// ever added. Plans/tasks creation share is likewise skipped (no creator
// column), as noted on refreshPipeGauges.
//
// LABELS. Every metric carries `persona`; the ones that are about a person also
// carry `user` — the linked users.id as a string, or "anon" when the Discord
// account has never run `/link` (PRD §11: "per-persona, per-user"). Cardinality
// is bounded by (personas × linked users), both small and human-scale.
//
// FIRE AND FORGET, ALWAYS. Nothing in here may fail a turn, a tick or a
// command: every exported function swallows its own errors, and the ones that
// need a DB lookup (resolving a Discord snowflake to a user id) do it OFF the
// caller's promise chain — the caller never awaits us.
//
// WHERE THE NUMBERS COME FROM (PRD §11 → emission point):
//
//   TTFPR                  relay.ts — thread created (channel_threads.created_at)
//                          → the first PR breadcrumb it OBSERVES for that thread.
//                          The relay is the natural observer: it already diffs
//                          every child run's pr_url every tick.
//   zero-command sessions   the counter PAIR `threads_total` (a conversation was
//                          created) and `commands_total` (a slash command was
//                          used). The rate is
//                          `1 - commands_total / threads_total`-ish, computed in
//                          the dashboard; we deliberately do not track
//                          per-thread command state here, since that would mean
//                          new durable state for a ratio nobody alerts on.
//   clarify rate           `agent_questions_total / user_messages_total`. The
//                          numerator is a HEURISTIC, stated plainly: an agent
//                          reply whose text ends in "?" counts as a question.
//                          Same heuristic the 👍/👎 reaction path already uses
//                          (agent-loop.ts hasOpenQuestion). It over-counts
//                          rhetorical questions and misses "let me know either
//                          way", but it needs no model call and no schema.
//   digest latency         commands.ts — wall time of a handled `/status`.
//   creation share         NOT emitted here: derived at scrape time from the DB
//                          in app/api/metrics/route.ts (runs whose id or
//                          parent_run_id is a mapped persona conversation are
//                          "messaging"). Plans and tasks carry no creator
//                          column, so their share is not derivable without a
//                          schema change — documented, skipped.
//   breadcrumbs / wakes    relay.ts (per posted breadcrumb) and
//                          channel-manager.ts (per pump-driven wake turn) — the
//                          two 15s pollers, which is where those events happen.
//
// SCRAPING THE PIPE. These counters live in the process that emits them, and
// the pipe is a standalone process (scripts/pipe.ts), so a scrape of the web
// app's /api/metrics sees the DB-derived gauges but zeroes for everything here.
// scripts/pipe.ts therefore serves the same registry on
// TASK_ORCH_PIPE_METRICS_PORT (off by default) — same exposition format, same
// metric names.

import { Counter, Gauge, Histogram } from "prom-client";

import * as repo from "@/lib/repo";
import { telemetry } from "@/lib/runner/telemetry";

/**
 * How stale a pending inbox event on a MAPPED persona conversation has to get
 * before it counts as "the pipe is not running" (the health signal in the
 * README). Read by the DB-backed gauge in app/api/metrics/route.ts.
 */
export const STALE_PENDING_MINUTES = 10;

/** The label used for a Discord account that has not linked an orchestrator user. */
export const ANON_USER = "anon";

interface PipeMetrics {
  userMessages: Counter<string>;
  agentQuestions: Counter<string>;
  agentReplies: Counter<string>;
  commands: Counter<string>;
  threads: Counter<string>;
  breadcrumbs: Counter<string>;
  wakes: Counter<string>;
  digestSeconds: Histogram<string>;
  timeToFirstPrSeconds: Histogram<string>;
  creationShare: Gauge<string>;
  stalePendingEvents: Gauge<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __taskOrchPipeMetrics: PipeMetrics | undefined;
}

function makeMetrics(): PipeMetrics {
  const registry = telemetry().registry;
  return {
    userMessages: new Counter({
      name: "task_orch_pipe_user_messages_total",
      help: "Inbound user messages handled as agent turns by a persona bot (clarify-rate denominator).",
      labelNames: ["persona", "user"] as const,
      registers: [registry],
    }),
    agentReplies: new Counter({
      name: "task_orch_pipe_agent_replies_total",
      help: "Persona replies delivered to a conversation (typed turns and unprompted milestone narrations).",
      labelNames: ["persona", "user"] as const,
      registers: [registry],
    }),
    agentQuestions: new Counter({
      name: "task_orch_pipe_agent_questions_total",
      help: "Persona replies that ended in '?' — the clarify-rate numerator (heuristic, see lib/pipe/metrics.ts).",
      labelNames: ["persona", "user"] as const,
      registers: [registry],
    }),
    commands: new Counter({
      name: "task_orch_pipe_commands_total",
      help: "Slash (or plain-language) commands handled without an agent turn, by command name.",
      labelNames: ["persona", "user", "command"] as const,
      registers: [registry],
    }),
    threads: new Counter({
      name: "task_orch_pipe_threads_total",
      help: "Persona conversations created (zero-command-session denominator).",
      labelNames: ["persona", "user"] as const,
      registers: [registry],
    }),
    breadcrumbs: new Counter({
      name: "task_orch_pipe_breadcrumbs_total",
      help: "Progress breadcrumbs the relay posted into a thread, by kind.",
      labelNames: ["persona", "kind"] as const,
      registers: [registry],
    }),
    wakes: new Counter({
      name: "task_orch_pipe_wakes_total",
      help: "Milestone (inbox-driven) turns the pipe's wake pump drove for a persona conversation.",
      labelNames: ["persona"] as const,
      registers: [registry],
    }),
    digestSeconds: new Histogram({
      name: "task_orch_pipe_digest_seconds",
      help: "Wall time to answer a /status digest (PRD §11 target: < 5s).",
      labelNames: ["persona"] as const,
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    timeToFirstPrSeconds: new Histogram({
      name: "task_orch_pipe_time_to_first_pr_seconds",
      help: "Thread created → first child PR observed by the relay (PRD §11 TTFPR; target median < 30 min).",
      labelNames: ["persona", "user"] as const,
      // Minutes-to-hours: 1m … 8h.
      buckets: [60, 300, 600, 1800, 3600, 7200, 14400, 28800],
      registers: [registry],
    }),
    creationShare: new Gauge({
      name: "task_orch_pipe_creation_share",
      help: "Entities created via the messaging surface vs elsewhere (PRD §11 channel share). DB-derived at scrape time.",
      labelNames: ["entity", "source"] as const,
      registers: [registry],
    }),
    stalePendingEvents: new Gauge({
      name: "task_orch_pipe_stale_pending_events",
      help: `Pending inbox events on mapped persona conversations older than ${STALE_PENDING_MINUTES}m — non-zero means the pipe is not draining them (i.e. it is down).`,
      labelNames: ["persona"] as const,
      registers: [registry],
    }),
  };
}

function metrics(): PipeMetrics {
  if (!globalThis.__taskOrchPipeMetrics) {
    globalThis.__taskOrchPipeMetrics = makeMetrics();
  }
  return globalThis.__taskOrchPipeMetrics;
}

/** Run a metric emission so that nothing it does can reach the caller. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[pipe:metrics] emission failed:", err);
  }
}

/**
 * The `user` label for a channel account: the linked users.id, or ANON_USER.
 *
 * Cached POSITIVELY only — an identity, once linked, does not change, while an
 * unlinked account may `/link` at any moment and must not be pinned to "anon"
 * for the life of the process. Bounded by the number of linked accounts.
 */
const userLabels = new Map<string, string>();

async function userLabel(channel: string, authorId?: string): Promise<string> {
  if (!authorId) return ANON_USER;
  const key = `${channel}:${authorId}`;
  const hit = userLabels.get(key);
  if (hit) return hit;
  const identity = await repo.getChannelIdentity(channel, authorId).catch(() => undefined);
  if (!identity) return ANON_USER;
  const label = String(identity.userId);
  userLabels.set(key, label);
  return label;
}

/** Resolve the user label off the caller's chain, then emit. Never throws. */
function withUser(
  channel: string,
  authorId: string | undefined,
  emit: (user: string) => void
): void {
  void userLabel(channel, authorId)
    .then((user) => safely(() => emit(user)))
    .catch(() => {});
}

/** Convert a linked users.id (or null) into the `user` label. */
export function userIdLabel(userId: number | null | undefined): string {
  return userId == null ? ANON_USER : String(userId);
}

// ── emission points ─────────────────────────────────────────────────────────

/** An inbound user message that will cost an agent turn (agent-loop.ts). */
export function recordUserMessage(personaId: string, channel: string, authorId?: string): void {
  withUser(channel, authorId, (user) => metrics().userMessages.labels(personaId, user).inc());
}

/**
 * A persona reply that reached the user (agent-loop.ts, both the typed-turn and
 * the milestone-narration paths). Also feeds the clarify-rate numerator when the
 * text ends in a question mark.
 */
export function recordAgentReply(
  personaId: string,
  text: string,
  channel: string,
  authorId?: string
): void {
  const isQuestion = text.trimEnd().endsWith("?");
  withUser(channel, authorId, (user) => {
    metrics().agentReplies.labels(personaId, user).inc();
    if (isQuestion) metrics().agentQuestions.labels(personaId, user).inc();
  });
}

/** A handled command — the zero-command-session numerator (commands.ts). */
export function recordCommand(
  personaId: string,
  command: string,
  channel: string,
  authorId?: string
): void {
  withUser(channel, authorId, (user) =>
    metrics().commands.labels(personaId, user, command).inc()
  );
}

/** Wall time of a handled `/status` (commands.ts). */
export function observeDigestSeconds(personaId: string, seconds: number): void {
  safely(() => metrics().digestSeconds.labels(personaId).observe(seconds));
}

/** A new persona conversation — the zero-command-session denominator. */
export function recordThreadCreated(personaId: string, userId: number | null): void {
  safely(() => metrics().threads.labels(personaId, userIdLabel(userId)).inc());
}

/** One posted breadcrumb (relay.ts). */
export function recordBreadcrumb(personaId: string, kind: string): void {
  safely(() => metrics().breadcrumbs.labels(personaId, kind).inc());
}

/** One pump-driven milestone turn (channel-manager.ts). */
export function recordWake(personaId: string): void {
  safely(() => metrics().wakes.labels(personaId).inc());
}

// ── DB-derived gauges (refreshed by GET /api/metrics, not by the pipe) ──────

/**
 * The messaging-vs-web creation share (PRD §11), as counts per entity+source.
 *
 * Reset-then-set, like the other DB-backed gauges in lib/runner/telemetry.ts: a
 * source that has no rows disappears rather than reporting a stale number.
 */
export function setCreationShare(
  rows: Array<{ entity: string; source: string; count: number }>
): void {
  safely(() => {
    metrics().creationShare.reset();
    for (const row of rows) metrics().creationShare.labels(row.entity, row.source).set(row.count);
  });
}

/** Mapped conversations' stale pending inbox events, by persona (health signal). */
export function setStalePendingEvents(rows: Array<{ persona: string; count: number }>): void {
  safely(() => {
    metrics().stalePendingEvents.reset();
    for (const row of rows) metrics().stalePendingEvents.labels(row.persona).set(row.count);
  });
}

/** Thread created → first child PR observed, in seconds (relay.ts). */
export function observeTimeToFirstPr(
  personaId: string,
  userId: number | null,
  seconds: number
): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  safely(() => metrics().timeToFirstPrSeconds.labels(personaId, userIdLabel(userId)).observe(seconds));
}
