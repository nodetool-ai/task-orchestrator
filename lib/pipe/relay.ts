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

import { and, count, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agentMessages, agentSessions, channelThreads } from "@/db/schema";
import { config } from "@/lib/config";
import * as runs from "@/lib/runs";
import { describe } from "@/lib/utils";

import { runLabel, runLink } from "./links";
import type { Channel, OutboundDraft } from "./types";

/** ≤1 progress breadcrumb per run per 10 minutes (PRD §8 collapse rule). */
export const PROGRESS_THROTTLE_MS = 10 * 60 * 1000;
/** More than this many breadcrumbs for one thread inside BATCH_WINDOW_MS get
 *  collapsed into a single digest message (PRD §8 "digests over feeds"). */
export const BATCH_THRESHOLD = 3;
export const BATCH_WINDOW_MS = 60 * 1000;

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
}

/** Per-thread state: batching window and the title machine. */
interface ThreadState {
  /** Timestamps of breadcrumb SENDS in this thread, for the batch rule. */
  recentSends: number[];
  /** Last title the relay itself set; a mismatch means a human edited it. */
  lastSetTitle?: string;
  /** Once a human has renamed the thread, the relay never renames it again. */
  humanEdited: boolean;
  /** Title state last applied, so an unchanged state is not re-written. */
  titleState?: TitleState;
}

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
  /** Conversations with a cancel awaiting a 👍 confirmation: key → run id. */
  private pendingCancels = new Map<string, { runId: number; at: number }>();
  private timer?: ReturnType<typeof setInterval>;
  private pollMs: number;
  private now: () => number;
  private ticking = false;

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
    try {
      const conversations = await this.loadConversations();
      if (conversations.size === 0) return;
      const children = await loadChildren([...conversations.keys()]);
      const byConversation = new Map<string, { conv: Conversation; lines: BreadcrumbLine[] }>();

      for (const child of children) {
        const conv = child.parentRunId == null ? undefined : conversations.get(child.parentRunId);
        if (!conv) continue;
        const lines = await this.breadcrumbsFor(child);
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
      await this.updateTitles(conversations, children);
    } finally {
      this.ticking = false;
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

  /** Which breadcrumbs (if any) this child owes the thread right now. */
  private async breadcrumbsFor(child: ChildRow): Promise<BreadcrumbLine[]> {
    // The progress window opens when we FIRST see the run, not at epoch —
    // otherwise the very next tick after "started" is already 10 minutes past
    // zero and the throttle never applies to the first progress line.
    const state =
      this.children.get(child.id) ??
      ({
        posted: new Set<Breadcrumb>(),
        lastProgressAt: this.now(),
        lastTurnCount: 0,
      } as ChildState);
    this.children.set(child.id, state);

    const out: BreadcrumbLine[] = [];
    const emit = (kind: Exclude<Breadcrumb, "progress">) => {
      if (state.posted.has(kind)) return;
      state.posted.add(kind);
      out.push({ kind, childId: child.id, text: formatBreadcrumb(kind, child) });
    };

    if (!isPending(child.status)) emit("started");
    if (child.prUrl) emit("pr");
    if (isFailure(child.status)) emit("failed");
    else if (child.status === "completed") emit("done");

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
   */
  private async updateTitles(
    conversations: Map<number, Conversation>,
    children: ChildRow[]
  ): Promise<void> {
    const byParent = new Map<number, ChildRow[]>();
    for (const c of children) {
      if (c.parentRunId == null) continue;
      const list = byParent.get(c.parentRunId) ?? [];
      list.push(c);
      byParent.set(c.parentRunId, list);
    }
    for (const [runId, conv] of conversations) {
      const kids = byParent.get(runId);
      if (!kids?.length) continue;
      const next = titleStateFor(kids);
      await this.applyTitle(conv, next).catch((err) =>
        console.error("[pipe:relay] thread rename failed:", describe(err))
      );
    }
  }

  private async applyTitle(conv: Conversation, next: TitleState): Promise<void> {
    const ch = this.byPersona.get(conv.personaId);
    if (!ch?.renameThread || !ch.threadTitle) return;
    const st = this.threadState(convKey(conv));
    if (st.humanEdited || st.titleState === next) return;

    const current = await ch.threadTitle(conv.externalId);
    if (current == null) return;
    if (st.lastSetTitle != null && current !== st.lastSetTitle) {
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

  /** Arm a confirm-gated cancel for a conversation (PRD §3: irreversible verb). */
  armCancel(conversationKey: string, runId: number): string {
    this.pendingCancels.set(conversationKey, { runId, at: this.now() });
    return `Cancel run #${runId}? React 👍 to confirm. ${runLink(runId)}`;
  }

  /** Consume an armed cancel, if one is live (5-minute window). */
  takeArmedCancel(conversationKey: string): number | undefined {
    const armed = this.pendingCancels.get(conversationKey);
    if (!armed) return undefined;
    this.pendingCancels.delete(conversationKey);
    if (this.now() - armed.at > 5 * 60 * 1000) return undefined;
    return armed.runId;
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

/** Aggregate child states → the thread's title glyph. */
export function titleStateFor(children: Array<{ status: string; prUrl: string | null }>): TitleState {
  if (children.some((c) => isRunning(c.status) || isPending(c.status))) return "working";
  if (children.some((c) => c.prUrl && c.status === "completed")) return "review";
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
