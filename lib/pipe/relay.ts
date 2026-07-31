// lib/pipe/relay.ts
//
// The progress relay (design §5, PRD §8): ambient breadcrumbs about a persona's
// CHILD runs, posted into the Discord thread that owns the persona conversation
// that spawned them, plus the thread-title status machine.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS POLLS THE DATABASE (the honest version)
//
// The design doc says "subscribe to the in-process run event bus
// (`runs.subscribe`)". That bus is real, but it is PER PROCESS and it only
// exists while THIS process is driving a turn: `subscribe()` looks the run up in
// the `runners` map, and `emitRunEvent` no-ops when the run is not in it. The
// pipe drives exactly one kind of turn — the persona's own server-runtime
// conversation. The runs this relay is about are the opposite: containerized
// WORKER children, dispatched by the control plane and streaming into the web
// process. Their bus lives over there. Subscribing here would silently receive
// nothing, which is the worst possible failure mode for an "ambient progress"
// feature — it looks wired and never fires.
//
// So the relay POLLS. Every `pollMs` it reads the child rows of the persona runs
// this pipe owns and diffs their (status, pr_url, agent-turn count) against what
// it last announced. That is robust across process boundaries and restarts, it
// costs two indexed queries per tick, and it degrades gracefully: a missed tick
// just means a breadcrumb lands a few seconds later. The alternative — a durable
// event tail over `agent_events` — buys ordering we do not need for one-line
// status glyphs, and would still need the same channel_threads join.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT MAY AND MAY NOT DO
//
//   • Breadcrumbs are PLAIN CHANNEL SENDS. They are never written to
//     agent_messages: an agent-role row there would be fed straight back to the
//     model by the postgres-turn context loader, so the persona would "remember"
//     saying things it never said. The relay only ever touches the transport.
//   • Breadcrumbs never carry a replyToken. A token is a single-use claim on a
//     slash-command's deferred reply owned by one turn; a relay message posting
//     with one would steal that turn's reply slot. `openDraft(id, text)` with no
//     token is an ordinary message and cannot.
//   • Breadcrumbs never @-mention (PRD §9). Mentions are reserved for the
//     persona's own milestone messages. The Discord adapter also suppresses all
//     mentions globally, so this is belt and braces.
//
// Milestone messages are NOT the relay's job: an inbox event (child.result, CI)
// on the persona run produces an agent turn that streams to the thread through
// the existing draft path. The relay only does the cheap signals.
//
// ─────────────────────────────────────────────────────────────────────────────
// RESTART BEHAVIOUR (M5 review B3) — the relay PRIMES, it does not replay
//
// All of the relay's state is in memory. A restart therefore starts with an
// empty "already posted" set, and a naive first tick would re-announce every
// child of every owned conversation — days of history, all at once, the moment
// the pipe comes back. So the FIRST TICK after startup is a PRIMING pass: it
// records each child's current status as already-announced and emits nothing.
// Only transitions observed after priming produce breadcrumbs.
//
// ACCEPTED TRADEOFF: a child that started, opened a PR or finished entirely
// DURING the downtime is silently skipped — its breadcrumbs are lost, not
// deferred. The alternative (a durable per-thread cursor over agent_events, so
// the relay resumes exactly where it stopped) is M6 work; for one-line ambient
// glyphs, silence about a window nobody was watching beats a wall of stale
// announcements. Children that appear AFTER the priming tick are new to this
// process and announce normally, so the steady-state feature is unaffected.
//
// The title machine has the same problem in a worse form — it would rename over
// a title a person chose while the bot was down — and its own answer: see
// applyTitle.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE RELAY KEEPS IN MEMORY, AND WHY IT IS BOUNDED
//
//   • `children`: one small entry per child run of a LIVE conversation. Terminal
//     children are evicted after TERMINAL_EVICT_MS; because the poll re-reads
//     every child of every owned conversation, an evicted child is re-admitted
//     on the next tick — SILENTLY, since a child first seen already terminal is
//     primed rather than announced (breadcrumbsFor). Eviction is therefore only
//     a real reclaim once the channel_threads row itself is gone; while the
//     conversation lives it just resets the (cheap) bookkeeping. Bound: live
//     conversations × their children.
//   • `threads`: one entry per conversation this process has relayed into, and
//     it is NEVER evicted. It carries title OWNERSHIP (humanEdited /
//     lastSetTitle), which must survive for the whole process lifetime: dropping
//     it would let the next tick re-adopt and rename a thread a human titled.
//     Bound: conversations served, a handful of bytes each.
//   • `breadcrumbRuns` / `pendingCancels`: explicitly capped / short-lived.

import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages, agentSessions, channelThreads, tasks } from "@/db/schema";
import { config } from "@/lib/config";
import * as runs from "@/lib/runs";
import { describe } from "@/lib/utils";

import { runLabel, runLink } from "./links";
import { observeTimeToFirstPr, recordBreadcrumb } from "./metrics";
import type { Channel, OutboundDraft } from "./types";

/** ≤1 progress breadcrumb per run per 10 minutes (PRD §8 collapse rule). */
export const PROGRESS_THROTTLE_MS = 10 * 60 * 1000;
/** More than this many breadcrumbs for one thread inside BATCH_WINDOW_MS get
 *  collapsed into a single digest message (PRD §8 "digests over feeds"). */
export const BATCH_THRESHOLD = 3;
export const BATCH_WINDOW_MS = 60 * 1000;
/**
 * How long a finished CHILD is kept in the in-memory child map after it goes
 * terminal. Long enough that a late duplicate row or a reaction on its last
 * breadcrumb still resolves; short enough that a long-lived pipe does not
 * accumulate one entry per run it has ever seen. Re-admitting an evicted
 * terminal child is harmless because `breadcrumbsFor` primes any child that is
 * ALREADY terminal the first time it sees it (see "prime on resight" there).
 *
 * Per-THREAD state is never evicted — see ThreadState.
 */
export const TERMINAL_EVICT_MS = 60 * 60 * 1000;
/** Armed cancels expire after this; a later 👍 says so instead of falling through. */
export const CANCEL_CONFIRM_MS = 5 * 60 * 1000;

/** The breadcrumb kinds, in the order a healthy child moves through them. */
export type Breadcrumb = "started" | "progress" | "pr" | "done" | "failed";

/** Thread-title status glyphs (PRD J2). */
export type TitleState = "working" | "review" | "done" | "failed";

const TITLE_GLYPHS: Record<TitleState, string> = {
  working: "🚧",
  review: "🔍",
  done: "✅",
  failed: "❌",
};
/** Every glyph the relay may have prefixed a title with, for stripping. */
const TITLE_GLYPH_RE = /^[🚧🔍✅❌]\s*/u;

/** A pipe channel the relay can post into. Structural, so tests fake it. */
export interface RelayChannel extends Pick<Channel, "name" | "openDraft"> {
  /** The persona this bot speaks as — the third key of the channel_threads row. */
  readonly personaId: string;
  /** Rename a thread (Discord "channel edit"). Optional: a transport without
   *  threads simply skips the title state machine. */
  renameThread?(externalId: string, title: string): Promise<void>;
  /** Current thread title, used to detect a human edit before renaming. */
  threadTitle?(externalId: string): Promise<string | null>;
}

/** One breadcrumb the relay decided to post this tick. */
interface BreadcrumbLine {
  kind: Breadcrumb;
  childId: number;
  text: string;
}

/** Child-run fields the relay diffs. */
interface ChildRow {
  id: number;
  parentRunId: number | null;
  goal: string;
  title: string | null;
  taskId: string | null;
  status: string;
  prUrl: string | null;
}

/** The conversation a persona run belongs to (the channel_threads 3-tuple). */
interface Conversation {
  channel: string;
  externalId: string;
  personaId: string;
  runId: number;
  /** When the thread was mapped — the START of the PRD §11 TTFPR clock. */
  createdAt: Date;
  /** The linked user the thread is attributed to, for the `user` metric label. */
  userId: number | null;
}

/** Everything the relay remembers about one child run between ticks. */
interface ChildState {
  /** Breadcrumb kinds already posted for this run — the dedupe set. */
  posted: Set<Breadcrumb>;
  /** Last progress breadcrumb time, for the 10-minute throttle. */
  lastProgressAt: number;
  /** Agent-turn count at the last progress breadcrumb (the progress SIGNAL). */
  lastTurnCount: number;
  /** The progress breadcrumb message, kept so the next one edits it in place. */
  progressDraft?: OutboundDraft;
  /** When this child was first seen terminal, for map eviction. */
  terminalAt?: number;
}

/**
 * Per-thread state: batching window and the title machine.
 *
 * NOT EVICTED, ever. This entry holds title OWNERSHIP — whether a human has
 * retitled the thread, and what the relay last set — and applyTitle's stand-down
 * is documented as lasting for the process's lifetime. An evicted entry would be
 * recreated blank on the very next tick (the conversation is still in
 * channel_threads), `humanEdited` would come back false, and the relay would
 * happily rename "Ivo's dark mode work" to "✅ Ivo's dark mode work" an hour
 * after standing down. The entries are tiny and bounded by the number of
 * conversations this pipe has relayed into.
 */
interface ThreadState {
  /** Timestamps of breadcrumb SENDS in this thread, for the batch rule. */
  recentSends: number[];
  /** Last title the relay itself set; a mismatch means a human edited it. */
  lastSetTitle?: string;
  /** Once a human has renamed the thread, the relay never renames it again. */
  humanEdited: boolean;
  /** Title state last applied, so an unchanged state is not re-written. */
  titleState?: TitleState;
  /** True once TTFPR has been observed for this thread — it is a FIRST-PR
   *  metric, so a second child's PR must not restart the clock. */
  ttfprObserved?: boolean;
}

/** A cancel awaiting its 👍 confirmation (PRD §3: irreversible verbs confirm). */
interface ArmedCancel {
  runId: number;
  at: number;
  /** The user who reacted ❌ — only they (or the thread owner) may confirm. */
  userId: string;
  /** The breadcrumb the ❌ landed on; part of the key, so two ❌s don't merge. */
  messageId: string;
  conversationKey: string;
}

/** What a 👍 in a conversation with (or without) an armed cancel means. */
export type ArmedCancelOutcome =
  /** Confirmed by someone entitled to: cancel this run. */
  | { kind: "cancel"; runId: number }
  /** Armed, but the 5-minute window closed. Say so; don't silently do nothing. */
  | { kind: "lapsed" }
  /** Armed by someone else and the reactor is not the thread owner: ignore it. */
  | { kind: "denied" };

export interface RelayOptions {
  /** Poll interval in ms. 0 disables the relay (start() becomes a no-op). */
  pollMs?: number;
  /** Injectable clock, so the throttle/batch rules are testable with fake timers. */
  now?: () => number;
}

/**
 * One relay for the whole pipe process, holding every persona bot's channel.
 * Built in scripts/pipe.ts from the `channels` array — ChannelManager owns the
 * loops and does not expose them, and the relay needs the channel handles, not
 * the loops.
 */
export class ProgressRelay {
  private byPersona = new Map<string, RelayChannel>();
  private children = new Map<number, ChildState>();
  private threads = new Map<string, ThreadState>();
  /** Breadcrumb message id → the run it is about (❌-on-a-breadcrumb cancel). */
  private breadcrumbRuns = new Map<string, number>();
  /** Armed cancels, keyed by conversation + arming user + breadcrumb message. */
  private pendingCancels = new Map<string, ArmedCancel>();
  private timer?: ReturnType<typeof setInterval>;
  private pollMs: number;
  private now: () => number;
  private ticking = false;
  /**
   * False until the first tick has completed. During that tick every child seen
   * is PRIMED (its current status recorded as announced) and nothing is emitted
   * — see the restart note in the header.
   */
  private primed = false;

  constructor(channels: RelayChannel[], opts: RelayOptions = {}) {
    for (const ch of channels) this.byPersona.set(ch.personaId, ch);
    this.pollMs = opts.pollMs ?? config.pipe.relayPollMs;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.pollMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error("[pipe:relay] tick failed:", err));
    }, this.pollMs);
    // Never hold the process open on the relay's account.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One poll: map owned conversations → their child runs → breadcrumbs. Guarded
   * against re-entry, because a slow tick (a rate-limited Discord send) must not
   * stack up behind the interval and double-post.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    // The first tick primes rather than announces (see the header). Captured
    // before any await so a re-entrant caller cannot flip it mid-pass.
    const priming = !this.primed;
    try {
      const conversations = await this.loadConversations();
      if (conversations.size === 0) {
        this.primed = true; // nothing to prime; the next tick announces normally
        return;
      }
      const children = await loadChildren([...conversations.keys()]);
      const byConversation = new Map<string, { conv: Conversation; lines: BreadcrumbLine[] }>();

      for (const child of children) {
        const conv = child.parentRunId == null ? undefined : conversations.get(child.parentRunId);
        if (!conv) continue;
        const lines = await this.breadcrumbsFor(child, priming);
        if (lines.length === 0) continue;
        const key = convKey(conv);
        const bucket = byConversation.get(key) ?? { conv, lines: [] };
        bucket.lines.push(...lines);
        byConversation.set(key, bucket);
      }

      for (const { conv, lines } of byConversation.values()) {
        await this.deliver(conv, lines).catch((err) =>
          console.error("[pipe:relay] breadcrumb send failed:", describe(err))
        );
      }
      await this.updateTitles(conversations, children, priming);
      this.evictSettled();
      // Only a pass that completed counts as priming: a tick that died on a DB
      // error primed nothing, and treating it as done would let the NEXT tick
      // announce the whole backlog — the exact failure priming exists to stop.
      this.primed = true;
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Drop long-settled CHILD entries so the map does not grow with every run this
   * process has ever seen. Only TERMINAL children are evicted, and only after
   * TERMINAL_EVICT_MS: an entry removed too early would be re-primed on the next
   * tick, which is silent, but its progress draft and breadcrumb bookkeeping
   * would be lost for no gain.
   *
   * Thread entries are deliberately NOT evicted — they carry title ownership,
   * which must outlive the children (see ThreadState).
   */
  private evictSettled(): void {
    const cutoff = this.now() - TERMINAL_EVICT_MS;
    for (const [id, st] of this.children) {
      if (st.terminalAt != null && st.terminalAt < cutoff) this.children.delete(id);
    }
  }

  // ── mapping ──────────────────────────────────────────────────────────────

  /**
   * The channel_threads rows this pipe owns, keyed by persona RUN id. "Owns" is
   * the 3-tuple join: a row's persona_id must match one of the bots in THIS
   * process, or the breadcrumb would be posted by a bot that cannot see the
   * thread (and, in a multi-pipe deployment, twice).
   */
  private async loadConversations(): Promise<Map<number, Conversation>> {
    const personaIds = [...this.byPersona.keys()];
    if (personaIds.length === 0) return new Map();
    const rows = await db
      .select({
        channel: channelThreads.channel,
        externalId: channelThreads.externalId,
        personaId: channelThreads.personaId,
        runId: channelThreads.runId,
        createdAt: channelThreads.createdAt,
        userId: channelThreads.userId,
      })
      .from(channelThreads)
      .where(inArray(channelThreads.personaId, personaIds));
    const out = new Map<number, Conversation>();
    for (const r of rows) {
      // A bot only relays into its OWN transport (channel name), so a future
      // Slack row for the same persona is skipped rather than mis-delivered.
      if (this.byPersona.get(r.personaId)?.name !== r.channel) continue;
      out.set(r.runId, r);
    }
    return out;
  }

  // ── breadcrumbs ──────────────────────────────────────────────────────────

  /**
   * Which breadcrumbs (if any) this child owes the thread right now.
   *
   * `priming` (the first tick after startup) records the child's CURRENT status
   * as already-announced and returns nothing, so a restart does not replay
   * history into the thread. See the header for the tradeoff.
   *
   * PRIME ON RESIGHT. The same silence applies, at any time, to a child seen for
   * the FIRST TIME already in a terminal status: its whole life happened while
   * we were not watching it, so announcing "⏳ started / ✅ done" now would be
   * replay, not news. This is what makes TERMINAL_EVICT_MS safe — an evicted
   * child is re-read by the very next poll (the conversation is still live) and,
   * without this, would re-announce its breadcrumbs every hour, forever. It also
   * hardens the relay against any other path that loses child state.
   *
   * The distinction that matters: a child we were ALREADY tracking when it went
   * terminal has an entry, so the transition is genuinely observed and its
   * terminal breadcrumb is emitted exactly once, as before.
   */
  private async breadcrumbsFor(child: ChildRow, priming = false): Promise<BreadcrumbLine[]> {
    // The progress window opens when we FIRST see the run, not at epoch —
    // otherwise the very next tick after "started" is already 10 minutes past
    // zero and the throttle never applies to the first progress line.
    const known = this.children.get(child.id);
    const state =
      known ??
      ({
        posted: new Set<Breadcrumb>(),
        lastProgressAt: this.now(),
        lastTurnCount: 0,
      } as ChildState);
    this.children.set(child.id, state);

    const terminal = isFailure(child.status) || child.status === "completed";
    if (terminal) state.terminalAt ??= this.now();

    // Record without announcing: the startup priming pass, or a child that was
    // already terminal the first time we laid eyes on it (see above).
    const silent = priming || (!known && terminal);

    const out: BreadcrumbLine[] = [];
    const emit = (kind: Exclude<Breadcrumb, "progress">) => {
      if (state.posted.has(kind)) return;
      state.posted.add(kind);
      // Priming records the transition without announcing it.
      if (silent) return;
      out.push({ kind, childId: child.id, text: formatBreadcrumb(kind, child) });
    };

    if (!isPending(child.status)) emit("started");
    if (child.prUrl) emit("pr");
    if (isFailure(child.status)) emit("failed");
    else if (child.status === "completed") emit("done");

    if (silent) {
      // Also anchor the progress signal, so the first post-priming progress line
      // reports turns since the restart rather than the run's whole history. A
      // terminal child will never post progress, so it is not worth the query.
      if (!terminal) state.lastTurnCount = await agentTurnCount(child.id);
      return out;
    }

    // Progress: the child produced new agent turns since the last progress
    // breadcrumb, and the 10-minute window has elapsed. Turn count is the only
    // honest cross-process progress signal we have without reading the child's
    // transcript into this process.
    if (isRunning(child.status) && !isFailure(child.status)) {
      const elapsed = this.now() - state.lastProgressAt;
      if (state.posted.has("started") && elapsed >= PROGRESS_THROTTLE_MS) {
        const turns = await agentTurnCount(child.id);
        if (turns > state.lastTurnCount) {
          state.lastTurnCount = turns;
          state.lastProgressAt = this.now();
          out.push({ kind: "progress", childId: child.id, text: formatProgress(child, turns) });
        }
      }
    }
    return out;
  }

  /**
   * Send this tick's breadcrumbs for one conversation, applying the etiquette:
   * a progress line EDITS the previous progress message where we still hold it,
   * and a burst collapses into one digest message.
   */
  private async deliver(conv: Conversation, lines: BreadcrumbLine[]): Promise<void> {
    const ch = this.byPersona.get(conv.personaId);
    if (!ch) return;
    const st = this.threadState(convKey(conv));
    const now = this.now();
    st.recentSends = st.recentSends.filter((t) => now - t < BATCH_WINDOW_MS);

    // PRD §11 metrics, emitted here because this is the point where a
    // breadcrumb becomes a message the user can see — a priming pass produces
    // no lines and so records nothing, which is what we want: the relay must
    // not report a PR it merely re-read after a restart as "first observed now".
    for (const line of lines) recordBreadcrumb(conv.personaId, line.kind);
    if (!st.ttfprObserved && lines.some((l) => l.kind === "pr")) {
      st.ttfprObserved = true;
      observeTimeToFirstPr(
        conv.personaId,
        conv.userId,
        (now - conv.createdAt.getTime()) / 1000
      );
    }

    // An in-place EDIT of the previous progress breadcrumb is not a new message
    // (PRD §8: "later breadcrumbs edit the previous one where possible"), so it
    // neither counts towards the batch threshold nor competes for attention.
    const fresh: BreadcrumbLine[] = [];
    for (const line of lines) {
      const prior = line.kind === "progress" ? this.children.get(line.childId)?.progressDraft : undefined;
      if (prior) {
        await prior.update(line.text).catch(() => fresh.push(line));
      } else {
        fresh.push(line);
      }
    }
    if (fresh.length === 0) return;

    // Digest rule: a burst collapses into ONE message rather than a feed.
    if (st.recentSends.length + fresh.length > BATCH_THRESHOLD) {
      const draft = await ch.openDraft(conv.externalId, fresh.map((l) => l.text).join("\n"));
      st.recentSends.push(now);
      this.registerDraft(draft, fresh);
      // A digest message covers several runs, so it can only serve as ONE run's
      // editable progress draft — editing it for run A would overwrite run B's
      // line with A's text. When the batch happens to hold exactly one progress
      // line we keep it (the common case: a progress line swept up in a burst of
      // starts); with two or more, those runs simply post a fresh line next
      // window instead of editing in place. Per-line edits need per-line
      // messages, which is precisely what the digest rule exists to avoid.
      const progress = fresh.filter((l) => l.kind === "progress");
      if (progress.length === 1) {
        const state = this.children.get(progress[0].childId);
        if (state) state.progressDraft = draft;
      }
      return;
    }
    for (const line of fresh) {
      const draft = await ch.openDraft(conv.externalId, line.text);
      st.recentSends.push(this.now());
      this.registerDraft(draft, [line]);
      if (line.kind === "progress") {
        const state = this.children.get(line.childId);
        if (state) state.progressDraft = draft;
      }
    }
  }

  /**
   * Remember a posted breadcrumb so an ❌ reaction on it can be resolved back to
   * the run it is about. A digest message covers several runs; the FIRST run in
   * it wins, which is the one whose event triggered the burst.
   */
  private registerDraft(draft: OutboundDraft, lines: BreadcrumbLine[]): void {
    if (draft.messageId) this.noteBreadcrumbMessage(draft.messageId, lines[0].childId);
  }

  private threadState(key: string): ThreadState {
    let st = this.threads.get(key);
    if (!st) {
      st = { recentSends: [], humanEdited: false };
      this.threads.set(key, st);
    }
    return st;
  }

  // ── thread title state machine ───────────────────────────────────────────

  /**
   * Rename each owned thread to reflect the aggregate state of its children:
   * 🚧 working → 🔍 PR open / in review → ✅ done / ❌ failed.
   *
   * HUMAN EDITS WIN. Before renaming we compare the CURRENT title with the last
   * one the relay set; if they differ, a person retitled the thread and the
   * relay stands down permanently for that thread. Someone who names a thread
   * has said what it is about, and having a bot overwrite that is worse than
   * losing a status glyph.
   *
   * The terminal ✅ prefers TASK state over run state where a child carries a
   * task id: a completed run with a merged task is genuinely done, while a
   * completed run whose task is still open is a PR waiting on a human (🔍).
   * Run state alone cannot tell those apart — it says "the agent stopped".
   */
  private async updateTitles(
    conversations: Map<number, Conversation>,
    children: ChildRow[],
    priming = false
  ): Promise<void> {
    const byParent = new Map<number, ChildRow[]>();
    for (const c of children) {
      if (c.parentRunId == null) continue;
      const list = byParent.get(c.parentRunId) ?? [];
      list.push(c);
      byParent.set(c.parentRunId, list);
    }
    const taskStates = await loadTaskStates(children);
    for (const [runId, conv] of conversations) {
      const kids = byParent.get(runId);
      if (!kids?.length) continue;
      const next = titleStateFor(kids, taskStates);
      await this.applyTitle(conv, next, priming).catch((err) =>
        console.error("[pipe:relay] thread rename failed:", describe(err))
      );
    }
  }

  /**
   * Apply one thread's title state.
   *
   * OWNERSHIP AFTER A RESTART (M5 review B3). `lastSetTitle` is in-memory, so on
   * the first application in this process we do not know whether the current
   * title is ours or a person's. The tie-break is the glyph:
   *
   *   • a title that already starts with one of OUR glyphs is machine-owned —
   *     adopt it and carry on;
   *   • a title WITHOUT a glyph on a thread that already had children when this
   *     process started (the priming pass) is treated as human-edited: either a
   *     person stripped our glyph and renamed it, or an older deployment owned
   *     it. Either way, standing down loses a glyph; renaming loses a human's
   *     words. We stand down;
   *   • a title without a glyph on a thread whose first children appeared while
   *     we were WATCHING is the thread's original bot-generated name, so it is
   *     adopted and glyphed. This is what keeps the feature working for every
   *     conversation started after boot.
   *
   * Persisting title ownership (so a restart knows exactly what it last set) is
   * M6 work; until then a stood-down thread stays stood down for this process.
   */
  private async applyTitle(conv: Conversation, next: TitleState, priming = false): Promise<void> {
    const ch = this.byPersona.get(conv.personaId);
    if (!ch?.renameThread || !ch.threadTitle) return;
    const st = this.threadState(convKey(conv));
    if (st.humanEdited || st.titleState === next) return;

    const current = await ch.threadTitle(conv.externalId);
    if (current == null) return;
    if (st.lastSetTitle == null) {
      // First application in this process: adopt or stand down (see above).
      if (!TITLE_GLYPH_RE.test(current) && priming) {
        console.log(
          `[pipe:relay] thread ${conv.externalId} has a title we don't own ("${current}") — ` +
            "leaving it alone"
        );
        st.humanEdited = true;
        return;
      }
    } else if (current !== st.lastSetTitle) {
      st.humanEdited = true;
      return;
    }
    const title = withGlyph(current, next);
    if (title === current) {
      st.titleState = next;
      st.lastSetTitle = current;
      return;
    }
    await ch.renameThread(conv.externalId, title);
    st.lastSetTitle = title;
    st.titleState = next;
  }

  // ── ❌-on-a-breadcrumb: confirm, then cancel ─────────────────────────────

  /** Remember which run a posted breadcrumb message is about. */
  noteBreadcrumbMessage(messageId: string, runId: number): void {
    this.breadcrumbRuns.set(messageId, runId);
    // Bounded: only the most recent breadcrumbs can plausibly be reacted to.
    if (this.breadcrumbRuns.size > 500) {
      const oldest = this.breadcrumbRuns.keys().next().value as string | undefined;
      if (oldest !== undefined) this.breadcrumbRuns.delete(oldest);
    }
  }

  /** The run a breadcrumb message is about, or undefined if it isn't one. */
  runForBreadcrumb(messageId: string): number | undefined {
    return this.breadcrumbRuns.get(messageId);
  }

  /**
   * Arm a confirm-gated cancel (PRD §3: irreversible verbs confirm first).
   *
   * Keyed by (conversation, arming user, breadcrumb message) rather than by
   * conversation alone: two people can ❌ two different breadcrumbs in the same
   * thread, and a conversation-wide key would let the second arm overwrite the
   * first — so one person's 👍 could cancel the run somebody else aimed at.
   */
  armCancel(
    conversationKey: string,
    runId: number,
    by: { userId: string; messageId: string }
  ): string {
    this.pendingCancels.set(armKey(conversationKey, by.userId, by.messageId), {
      runId,
      at: this.now(),
      userId: by.userId,
      messageId: by.messageId,
      conversationKey,
    });
    return `Cancel run #${runId}? React 👍 to confirm. ${runLink(runId)}`;
  }

  /**
   * Resolve a 👍 against this conversation's armed cancels.
   *
   * Only the user who armed it — or the thread's owner, who is entitled to
   * everything in their own thread — may confirm. A 👍 from anyone else is
   * `denied` and leaves the arm intact, so the person who asked for the cancel
   * can still confirm it. An arm past CANCEL_CONFIRM_MS is `lapsed`: the caller
   * says so rather than letting the 👍 fall through to the yes/no path, where it
   * would silently become a "yes" answering some unrelated question.
   */
  takeArmedCancel(
    conversationKey: string,
    by: { userId: string; isOwner?: boolean }
  ): ArmedCancelOutcome | undefined {
    let mine: { key: string; armed: ArmedCancel } | undefined;
    let others = false;
    for (const [key, armed] of this.pendingCancels) {
      if (armed.conversationKey !== conversationKey) continue;
      if (armed.userId === by.userId || by.isOwner) {
        // Newest arm wins: it is the one the 👍 is answering.
        if (!mine || armed.at >= mine.armed.at) mine = { key, armed };
      } else {
        others = true;
      }
    }
    if (!mine) return others ? { kind: "denied" } : undefined;
    this.pendingCancels.delete(mine.key);
    if (this.now() - mine.armed.at > CANCEL_CONFIRM_MS) return { kind: "lapsed" };
    return { kind: "cancel", runId: mine.armed.runId };
  }

  /** Cancel a run after confirmation. Returns the line to post back. */
  async confirmCancel(runId: number): Promise<string> {
    try {
      await runs.cancel(runId);
      return `❌ Cancelled run #${runId}.`;
    } catch (err) {
      return `⚠️ Couldn't cancel run #${runId}: ${describe(err)}`;
    }
  }
}

// ── pure helpers (exported for tests) ───────────────────────────────────────

export function convKey(conv: { channel: string; externalId: string; personaId: string }): string {
  return `${conv.channel}:${conv.externalId}:${conv.personaId}`;
}

/** Key for one armed cancel: conversation + who armed it + which breadcrumb. */
function armKey(conversationKey: string, userId: string, messageId: string): string {
  return `${conversationKey}|${userId}|${messageId}`;
}

const FAILURE_STATUSES = new Set(["failed", "cancelled", "budget_exhausted"]);
const PENDING_STATUSES = new Set(["pending"]);
const RUNNING_STATUSES = new Set(["preparing", "running", "parked", "idle"]);

function isFailure(status: string): boolean {
  return FAILURE_STATUSES.has(status);
}
function isPending(status: string): boolean {
  return PENDING_STATUSES.has(status);
}
function isRunning(status: string): boolean {
  return RUNNING_STATUSES.has(status);
}

/** One-line, glyph-prefixed, mention-free (PRD §8). */
export function formatBreadcrumb(
  kind: Exclude<Breadcrumb, "progress">,
  child: { id: number; title: string | null; taskId: string | null; goal: string; prUrl: string | null }
): string {
  const label = runLabel(child);
  const task = child.taskId ? ` (task \`${child.taskId}\`)` : "";
  switch (kind) {
    case "started":
      return `⏳ run #${child.id} started — ${label}${task} · ${runLink(child.id)}`;
    case "pr":
      return `✅ PR opened: ${child.prUrl} · run #${child.id}`;
    case "done":
      return `✅ run #${child.id} done — ${label} · ${runLink(child.id)}`;
    case "failed":
      return `❌ run #${child.id} failed — ${label} · ${runLink(child.id)}`;
  }
}

export function formatProgress(
  child: { id: number; title: string | null; taskId: string | null; goal: string },
  turns: number
): string {
  return `🔍 run #${child.id}: ${turns} turn${turns === 1 ? "" : "s"} in — ${runLabel(child)} · ${runLink(child.id)}`;
}

/** Task states that mean "this work landed" — the ✅ signal (lib/types.ts). */
const DONE_TASK_STATES = new Set(["merged", "done"]);

/**
 * Aggregate child states → the thread's title glyph.
 *
 * `taskStates` maps a child's task id to its current tasks.state. Where a child
 * HAS a task, that state is authoritative for the ✅/🔍 distinction: a completed
 * run whose task merged is done, while a completed run with an open PR and a
 * task that has not merged is in review, no matter how the run itself landed.
 * A child with no task id (an ad-hoc run) keeps the run-state fallback: a PR on
 * a completed run means review.
 */
export function titleStateFor(
  children: Array<{ status: string; prUrl: string | null; taskId?: string | null }>,
  taskStates: Map<string, string> = new Map()
): TitleState {
  if (children.some((c) => isRunning(c.status) || isPending(c.status))) return "working";
  const taskDone = (c: { taskId?: string | null }): boolean | undefined => {
    const state = c.taskId ? taskStates.get(c.taskId) : undefined;
    return state === undefined ? undefined : DONE_TASK_STATES.has(state);
  };
  const inReview = children.some((c) => {
    if (c.status !== "completed" || !c.prUrl) return false;
    return taskDone(c) !== true; // task known-merged ⇒ not review; else PR is open
  });
  if (inReview) return "review";
  if (children.every((c) => c.status === "completed")) return "done";
  if (children.some((c) => isFailure(c.status))) return "failed";
  return "working";
}

/** Replace (or add) the leading status glyph on a thread title. */
export function withGlyph(title: string, state: TitleState): string {
  const base = title.replace(TITLE_GLYPH_RE, "").trim();
  const next = `${TITLE_GLYPHS[state]} ${base}`;
  return next.length > 100 ? `${next.slice(0, 99)}…` : next;
}

// ── DB reads ────────────────────────────────────────────────────────────────

async function loadChildren(parentRunIds: number[]): Promise<ChildRow[]> {
  if (parentRunIds.length === 0) return [];
  return db
    .select({
      id: agentSessions.id,
      parentRunId: agentSessions.parentRunId,
      goal: agentSessions.goal,
      title: agentSessions.title,
      taskId: agentSessions.taskId,
      status: agentSessions.status,
      prUrl: agentSessions.prUrl,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.parentRunId, parentRunIds));
}

/**
 * Current state of every task the visible children carry, for the title
 * machine's ✅ decision. One indexed `IN (...)` query per tick, skipped entirely
 * when no child has a task id.
 */
async function loadTaskStates(children: ChildRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(children.map((c) => c.taskId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  return new Map(rows.map((r) => [r.id, r.state as string]));
}

/** Agent turns recorded on a run — the relay's progress signal. */
async function agentTurnCount(runId: number): Promise<number> {
  const row = (
    await db
      .select({ n: count() })
      .from(agentMessages)
      .where(and(eq(agentMessages.runId, runId), eq(agentMessages.role, "agent")))
  )[0];
  return Number(row?.n ?? 0);
}
