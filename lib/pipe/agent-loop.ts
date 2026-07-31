// lib/pipe/agent-loop.ts
//
// The agent loop — claude-pipe's core, adapted to drive this project's existing
// agent runtime. For each inbound message it (1) intercepts slash commands,
// (2) resolves/creates the chat run for the conversation, and (3) streams one
// agent turn via lib/chat.ts:runChat (which forwards to lib/runs.ts:append),
// rendering the reply into the channel by editing a single draft message in
// place. Because it delegates to runChat, a Discord turn is identical to a web
// composer turn: same tools, same persistence, same per-run lock.

import * as chat from "@/lib/chat";
import { hasPendingInboxEvents } from "@/lib/inbox";
import * as runs from "@/lib/runs";
import { describe } from "@/lib/utils";
import type { RunEnvelope } from "@/lib/pi-event-mapper";

import * as repo from "@/lib/repo";

import { config as appConfig } from "@/lib/config";

import { agentTurnCount, startFreshConversation } from "./carryover";
import { ACK_REACTION, STOP_REACTION, YES_REACTION } from "./reactions";
import { TOKEN_IN_MESSAGE_NOTICE, containsApiToken, handleCommand, isCommandText } from "./commands";
import { TranscriptBuilder, chunkForDiscord } from "./render";
import {
  currentRunId,
  getOrCreateRun,
  hasMapping,
  resolveUserId,
  threadOwnerExternalId,
} from "./session-store";
import type { ArmedCancelOutcome } from "./relay";
import type { Channel, InboundMessage, PipeConfig } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bounded wait for the in-process bus to go live (see the attach loop below).
// Only matters in dev mode, where runs.append registers its runner synchronously
// near the start of a turn — a few polls is plenty. In the containerized/relay
// deploy runs.isLive() never returns true, so without a bound this would spin
// for the whole turn; the bound plus the sawGeneratorFrame bailout (below) keep
// it cheap there.
const ATTACH_POLL_TIMEOUT_MS = 3000;

/**
 * The subset of the relay the loop needs to resolve reactions (PRD §6). Kept as
 * a narrow structural type rather than importing ProgressRelay so the loop
 * stays testable without a relay and the dependency points one way.
 */
export interface ReactionResolver {
  /** The run a breadcrumb message is about, or undefined if it isn't one. */
  runForBreadcrumb(messageId: string): number | undefined;
  /** Arm a confirm-gated cancel; returns the line to post. */
  armCancel(
    conversationKey: string,
    runId: number,
    by: { userId: string; messageId: string }
  ): string;
  /** Resolve a 👍 against this conversation's armed cancels (see relay.ts). */
  takeArmedCancel(
    conversationKey: string,
    by: { userId: string; isOwner?: boolean }
  ): ArmedCancelOutcome | undefined;
  /** Cancel a confirmed run; returns the line to post. */
  confirmCancel(runId: number): Promise<string>;
}

/** The last message THIS process posted as the persona in a conversation. */
interface OwnMessage {
  /** Channel-native id, when the transport gave us one (absent for interaction replies). */
  messageId?: string;
}

export class AgentLoop {
  // Per-conversation handling chains (see M9a below), keyed by
  // `${msg.channel}:${msg.externalId}:${msg.personaId}`. Cleared once a chain
  // drains so the map never grows past the conversations currently in flight.
  private queues = new Map<string, Promise<void>>();
  // Conversations this process has already greeted (PRD J1). Bounded by the
  // number of conversations seen since boot; entries are ~60 bytes and a
  // restart just re-checks the DB mapping, so no eviction is warranted.
  private greeted = new Set<string>();
  // The last message this process posted as the persona, per conversation. It is
  // what makes "👍 answers the persona's question" precise: a 👍 on ANY other
  // message (a breadcrumb, an older reply, someone else's post) is not an answer
  // to the open question and must not be injected as one. Bounded by the number
  // of conversations this process has spoken in; one small record each.
  private lastOwnMessage = new Map<string, OwnMessage>();

  constructor(
    private channel: Channel,
    private config: PipeConfig,
    /** Optional: present once scripts/pipe.ts has built the breadcrumb relay. */
    private relay?: ReactionResolver
  ) {}

  async handle(msg: InboundMessage): Promise<void> {
    // 0. Reactions-as-input (PRD §6). Resolved BEFORE commands, because the
    // meaning of the reaction decides which path it takes: ❌ on a relay
    // breadcrumb cancels that child run (with a confirmation) instead of
    // interrupting this thread's turn, and 👍/👎 only mean yes/no when the
    // persona actually left a question hanging.
    if (msg.reaction) {
      const consumed = await this.handleReaction(msg).catch((err) => {
        console.error("[pipe] reaction handling failed:", err);
        return true; // never fall through to a turn on an error
      });
      if (consumed) return;
    }

    // 1. Command interception (before any LLM call, and BEFORE the
    // per-conversation queue below). Commands run immediately, out of band:
    // /stop's whole point is interrupting a turn that's already in flight, so
    // it must never wait behind the very turn it's trying to kill.
    //
    // isCommandText, not `startsWith("/")`: a bare "stop"/"cancel" is a
    // plain-language interrupt (PRD §6) and gets the same pre-queue treatment,
    // otherwise it would sit behind the turn the user is trying to abort and
    // arrive as a prompt after it finished.
    if (isCommandText(msg.text)) {
      let result;
      try {
        result = await handleCommand(msg, this.config);
      } catch (err) {
        // A command that throws after its slash interaction was deferred would
        // otherwise leave the user staring at "thinking…" forever and leak the
        // pending interaction. Answer with the error — which also consumes the
        // claim, so nothing is left dangling (PRD §10: never silent).
        console.error("[pipe] command failed:", err);
        await this.channel
          .send(msg.externalId, `⚠️ That command failed: ${describe(err)}`, msg.replyToken)
          .catch(() => {});
        return;
      }
      if (result.handled) {
        if (result.reply) await this.channel.send(msg.externalId, result.reply, msg.replyToken);
        return; // command consumed the message
      }
      // else fall through: an unrecognized "/x" is treated as a normal prompt,
      // so it enqueues below like any other message.
    }

    // 1a. Token-shaped text never reaches the agent (M4 review F5). A mistyped
    // `/lnik tot_…` (or a token pasted into ordinary conversation) would
    // otherwise be persisted verbatim in agent_messages and shipped to a model
    // provider. Refuse pre-queue, before anything is written, and say so without
    // echoing the token. A well-formed `/link` was already handled above, so
    // this only ever catches the cases where the secret is about to be leaked.
    if (containsApiToken(msg.text)) {
      await this.channel
        .send(msg.externalId, TOKEN_IN_MESSAGE_NOTICE, msg.replyToken)
        .catch((err) => console.error("[pipe] token-notice send failed:", err));
      return;
    }

    // 1b. Onboarding (PRD J1). The very first DM from an allowlisted user —
    // no conversation for this persona yet and no linked account — gets a
    // 3-line intro BEFORE the turn runs, so the reply lands under it. Guild
    // channels never get this: the intro belongs in the private workspace, and
    // a channel is exactly where it would be noise.
    await this.maybeSendOnboarding(msg).catch((err) =>
      console.error("[pipe] onboarding intro failed:", err)
    );

    // 2. Serialize turns per conversation (M9a). Two messages landing in the
    // same Discord thread milliseconds apart both see the run as "live" as
    // soon as the first opens its draft, so a naive per-message dispatch lets
    // the second message's bus subscription attach mid-first-turn — its draft
    // then renders the first turn's reply, and on abort gets FINALIZED from
    // that contaminated builder. runs.append's per-run lock only serializes
    // the DB/model work, not the draft + bus wiring around it, so the chain
    // has to live here, above that lock. A simple promise chain per
    // conversation key does it; distinct conversations get distinct chains and
    // still run concurrently.
    const key = `${msg.channel}:${msg.externalId}:${msg.personaId}`;
    const prior = this.queues.get(key) ?? Promise.resolve();
    const turn = prior.then(() => this.runTurn(msg));
    // Swallow so a failed turn never wedges the chain for the next message;
    // the real error still propagates to the caller via `turn` below.
    const settled = turn.catch(() => {});
    this.queues.set(key, settled);
    void settled.finally(() => {
      // Only delete if nobody chained past us meanwhile — a message that
      // arrived while this one was running already replaced the entry.
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return turn;
  }

  /**
   * Reactions as input (PRD §6). Returns true when the reaction was fully
   * handled here and must NOT continue into the normal message path.
   *
   *   ❌ on a relay breadcrumb  → confirm-then-cancel that child run.
   *   ❌ anywhere else          → fall through as "/stop" (the M4 behavior).
   *   👍 confirming a cancel THIS user armed (or the thread owner's 👍) → cancel.
   *   👍 confirming someone else's armed cancel → ignored.
   *   👍 after the confirmation window closed → say it lapsed, cancel nothing.
   *   👍/👎 ON the persona's open question → inject "yes"/"no" as a message.
   *   👍/👎 anywhere else, or with no question open → ignored, silently.
   *
   * WHICH MESSAGE WAS REACTED TO IS PART OF THE MEANING (M5 review S4). The
   * thread is full of the bot's own messages — breadcrumbs above all — and a 👍
   * on one of THOSE is a thumbs-up, not an answer. So a yes/no injection
   * requires the reaction to be on the persona's latest message; where this
   * process does not know what that was (it restarted, or the reply went out as
   * an interaction response with no addressable id) we at least refuse the
   * messages we can positively identify as NOT questions — the relay's
   * breadcrumbs.
   *
   * THE QUESTION HEURISTIC, stated plainly: the persona is considered to be
   * waiting on an answer when the LAST agent text on this conversation's run
   * ends with "?". That is crude — a message ending in a rhetorical question
   * counts, and a question phrased as "let me know either way" does not — but
   * it needs no new state, no model call and no schema, and its failure modes
   * are both harmless: a stray "yes" the persona can absorb, or a 👍 that does
   * nothing (the user types "yes" instead). A structured pending-question
   * signal already exists for RUNS (`pending_question`), but a persona chat
   * asking conversationally never sets it.
   */
  private async handleReaction(msg: InboundMessage): Promise<boolean> {
    const r = msg.reaction!;
    const key = `${msg.channel}:${msg.externalId}:${msg.personaId}`;

    if (r.emoji === STOP_REACTION) {
      const runId = this.relay?.runForBreadcrumb(r.messageId);
      if (runId == null) return false; // ordinary ❌ → "/stop", handled below
      const ask = this.relay!.armCancel(key, runId, {
        userId: msg.authorId,
        messageId: r.messageId,
      });
      await this.channel.send(msg.externalId, ask).catch(() => {});
      return true;
    }

    if (r.emoji === YES_REACTION && this.relay) {
      const owner = await threadOwnerExternalId(msg.channel, msg.externalId, msg.personaId).catch(
        () => null
      );
      const armed = this.relay.takeArmedCancel(key, {
        userId: msg.authorId,
        isOwner: owner != null && owner === msg.authorId,
      });
      if (armed?.kind === "cancel") {
        const line = await this.relay.confirmCancel(armed.runId);
        await this.channel.send(msg.externalId, line).catch(() => {});
        return true;
      }
      if (armed?.kind === "lapsed") {
        // Never fall through: an expired confirmation that quietly became a
        // "yes" to whatever question happens to be open is the worst outcome.
        await this.channel
          .send(msg.externalId, "That cancel confirmation lapsed — react ❌ again to redo it.")
          .catch(() => {});
        return true;
      }
      // 'denied': someone else armed it. Consume the reaction (it clearly meant
      // the cancel, not an answer) and say nothing.
      if (armed?.kind === "denied") return true;
    }

    // 👍/👎 as an answer: only ON the persona's open question.
    if (!this.reactedToOwnLatest(key, r.messageId)) return true; // consumed = ignored
    if (!(await this.hasOpenQuestion(msg))) return true; // consumed = ignored
    return false; // fall through: msg.text is already "yes"/"no"
  }

  /**
   * True when a reaction landed on the persona's own latest message in this
   * conversation — the only message a 👍/👎 can be answering.
   *
   * When this process knows its last message id, the check is exact. When it
   * does not (restart, or an interaction reply with no id), we fall back to the
   * heuristic but still reject anything the relay can identify as a breadcrumb.
   */
  private reactedToOwnLatest(key: string, messageId: string): boolean {
    const own = this.lastOwnMessage.get(key);
    if (own?.messageId) return own.messageId === messageId;
    return this.relay?.runForBreadcrumb(messageId) == null;
  }

  /** Remember the message this turn just posted (see reactedToOwnLatest). */
  private noteOwnMessage(key: string, messageId?: string): void {
    this.lastOwnMessage.set(key, { messageId });
  }

  /**
   * Drive a turn the USER did not ask for: a persona conversation with pending
   * inbox events (`child.result`, `gh.pr.merged`, `timer.fired`) whose narration
   * is the milestone message the thread is waiting for (design §5 "inbox echo").
   *
   * WHY THIS EXISTS AT ALL. The design says the inbox-driven turn "already
   * works because injection goes through the same append() path". It does not,
   * quite: append() streams to whoever is holding a draft, and on an
   * inbox-driven turn nobody is — the pipe only opens a draft when it handles an
   * inbound message. So the pipe drives the wake ITSELF (rather than letting the
   * control plane's pump do it) and holds the draft while it runs. Because
   * wakeServerRun's append() executes IN THIS PROCESS, the run lands in the
   * local `runners` map and runs.subscribe carries its envelopes here.
   *
   * SERIALIZATION: enqueued on the same per-conversation chain as user turns, so
   * a milestone can't interleave with a message the user just sent — and
   * wakeServerRun itself takes the server claim, so a wake racing the web
   * process is a clean no-op rather than a double turn.
   *
   * The draft is opened LAZILY, on the first envelope: a wake that turns out to
   * have nothing to say (the events were already drained) must not leave a
   * stray "…" in the thread.
   *
   * DELIVERY IS NOT ALLOWED TO DEPEND ON THE LIVE BUS. The wake consumes the
   * inbox event whether or not anyone hears the envelopes, so a missed
   * subscription used to mean the milestone was gone for good, with nothing
   * logged. runWakeTurn therefore (1) subscribes BEFORE waking, closing the
   * ordering race at its root, and (2) falls back to the durable agent_messages
   * tail written by the turn when the live transcript came out empty — so the
   * narration survives even if every envelope is missed.
   */
  async wakeConversation(externalId: string, personaId: string, channel = "discord"): Promise<void> {
    const key = `${channel}:${externalId}:${personaId}`;
    const prior = this.queues.get(key) ?? Promise.resolve();
    const turn = prior.then(() => this.runWakeTurn(externalId, personaId, channel));
    const settled = turn.catch((err) => console.error("[pipe] wake turn failed:", err));
    this.queues.set(key, settled);
    void settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return settled;
  }

  private async runWakeTurn(externalId: string, personaId: string, channel: string): Promise<void> {
    const key = `${channel}:${externalId}:${personaId}`;
    const runId = await currentRunId(channel, externalId, personaId);
    if (runId == null) return;
    if (runs.isLive(runId)) return;
    if (!(await hasPendingInboxEvents(runId))) return;

    const builder = new TranscriptBuilder();
    let draft: Awaited<ReturnType<Channel["openDraft"]>> | undefined;
    let lastEdit = 0;
    let pendingEdit: Promise<void> = Promise.resolve();

    const onEvent = (event: unknown) => {
      const e = event as { type?: string; sdk?: RunEnvelope };
      if (e.type !== "sdk" || !e.sdk) return;
      builder.push(e.sdk);
      const now = Date.now();
      if (now - lastEdit < this.config.editThrottleMs) return;
      lastEdit = now;
      const text = builder.text();
      if (!text) return;
      pendingEdit = pendingEdit
        .then(async () => {
          draft ??= await this.channel.openDraft(externalId, chunkForDiscord(text)[0]);
          await draft.update(chunkForDiscord(text)[0]);
        })
        .catch(() => {});
    };

    // SUBSCRIBE BEFORE WAKING. The old code kicked wakeServerRun and polled
    // runs.isLive() to find the bus afterwards, which loses the whole turn when
    // it registers, emits and closes inside one poll interval — a fast turn (a
    // cached/short model reply, or a loaded CI box where the 20ms timer fires
    // late) then produced no envelopes here, no lazy draft, and no error: the
    // inbox event was consumed and its narration silently dropped.
    // subscribeRunEvents attaches the listener the moment the run's runner
    // registers, so there is no window to lose.
    const unsubscribe = runs.subscribeRunEvents(runId, onEvent);
    // Durable cursor for the fallback below, taken before the turn writes.
    const cursor = await runs.streamCursor(runId).catch(() => null);

    try {
      await runs.wakeServerRun(runId);
    } finally {
      unsubscribe();
    }
    await pendingEdit;

    // THE NARRATION IS THE DELIVERABLE, so live envelopes are an optimization,
    // never the only copy. Whatever the turn said is in agent_messages by the
    // time wakeServerRun returns; if we heard nothing live (bus never emitted,
    // a racing driver drove the turn, an envelope shape we don't render), read
    // it back from the durable tail and deliver that instead. Only text written
    // AFTER the cursor counts — the run's older replies are not this milestone.
    let text = builder.text();
    if (!text && cursor) {
      text =
        (await runs
          .agentTextAfter(runId, cursor.msgId)
          .catch((err) => {
            console.error("[pipe] milestone durable read failed:", err);
            return null;
          })) ?? "";
    }
    if (!text) return; // nothing to say — and no empty draft left behind

    // THE MILESTONE MENTION (PRD §9). This turn is the one message the thread is
    // actually waiting for — "the PR is green", "the child failed" — and it
    // arrives unprompted, possibly hours later, so it is the one message allowed
    // to ping. The mention goes to the THREAD'S OWNER (channel_threads.user_id →
    // their linked Discord account), and only on this send: the client-wide
    // `parse: []` suppression stays in force for everything else, breadcrumbs
    // included. An unlinked or unattributed thread gets no mention and no
    // apology for it.
    const owner = await threadOwnerExternalId(channel, externalId, personaId).catch(() => null);
    const body = owner ? `<@${owner}> ${text}` : text;
    const mention = owner ? { mentionUsers: [owner] } : undefined;

    const chunks = chunkForDiscord(body);
    if (draft) await draft.finalize(chunks[0], mention);
    else await this.channel.send(externalId, chunks[0], undefined, mention);
    this.noteOwnMessage(key, draft?.messageId);
    for (const extra of chunks.slice(1)) {
      await this.channel.send(externalId, extra).catch((err) =>
        console.error("[pipe] milestone overflow send failed:", err)
      );
    }
  }

  /** True when the persona's last word on this conversation was a question. */
  private async hasOpenQuestion(msg: InboundMessage): Promise<boolean> {
    const runId = await currentRunId(msg.channel, msg.externalId, msg.personaId);
    if (runId == null) return false;
    const text = await runs.lastAgentText(runId);
    return text != null && text.trimEnd().endsWith("?");
  }

  /**
   * PRD J1: a 3-line intro on the first-ever DM with this persona — who I am,
   * one example ask, and (only when unlinked) the `/link` nudge sold by its
   * benefit. Sent once per conversation: the `greeted` set covers two messages
   * racing in before either has created a mapping, and the mapping itself
   * covers process restarts.
   */
  private async maybeSendOnboarding(msg: InboundMessage): Promise<void> {
    if (!msg.isDirectMessage) return;
    const key = `${msg.channel}:${msg.externalId}:${msg.personaId}`;
    // Claim SYNCHRONOUSLY, before any await: two first messages arriving
    // milliseconds apart both reach this method before either has created a
    // mapping, and a check that awaited first would greet twice.
    if (this.greeted.has(key)) return;
    this.greeted.add(key);
    if (await hasMapping(msg.channel, msg.externalId, msg.personaId)) return;
    const linked = (await resolveUserId(msg.channel, msg.authorId)) != null;

    const persona = await repo.getPersona(msg.personaId);
    const lines = [
      `I'm **${persona?.name ?? msg.personaId}** — ${persona?.description?.trim() || "your agent here"}.`,
      "Try me: *ship a small fix* or *what's in flight?*",
    ];
    if (!linked) {
      lines.push(
        "Want your work attributed to your account? Grab a token in the web UI and DM me `/link <token>`."
      );
    }
    await this.channel.send(msg.externalId, lines.join("\n"));
  }

  /**
   * Long-thread guard (PRD §10). A persona conversation rebuilds its model
   * context from agent_messages every turn, so an unbounded thread eventually
   * rebuilds an unbounded prompt. Past the turn cap the persona SAYS SO and the
   * conversation continues in a fresh run seeded with a carried-over summary
   * (lib/pipe/carryover.ts — assembled without a model call).
   *
   * Announced before the reset, never after: "this thread's getting long, I'll
   * keep the summary and start fresh here" is information the user needs to
   * interpret the persona's suddenly shorter memory. Any failure leaves the old
   * run in place — a too-long conversation still works, so this must never be
   * the thing that eats a message.
   */
  private async guardLongThread(msg: InboundMessage, runId: number): Promise<number> {
    const cap = appConfig.pipe.turnCap;
    if (cap <= 0) return runId;
    try {
      if ((await agentTurnCount(runId)) < cap) return runId;
      await this.channel
        .send(
          msg.externalId,
          "This thread's getting long — I'll keep a summary and start fresh from here. " +
            "Anything you've taught me is remembered."
        )
        .catch(() => {});
      const fresh = await startFreshConversation({
        channel: msg.channel,
        externalId: msg.externalId,
        personaId: msg.personaId,
        authorId: msg.authorId,
        model: this.config.defaultModel,
      });
      return fresh.runId;
    } catch (err) {
      console.error("[pipe] long-thread reset failed; continuing on the old run:", err);
      return runId;
    }
  }

  private async runTurn(msg: InboundMessage): Promise<void> {
    const key = `${msg.channel}:${msg.externalId}:${msg.personaId}`;
    // 2. Resolve or create the persona conversation for this thread.
    //
    // This can legitimately fail — most plausibly runs.create's server-runtime
    // guardrail rejecting a persona whose tools profile was edited to something
    // unsafe after the pipe booted, but also a deleted persona or a DB blip. It
    // happens BEFORE openDraft, so there is no draft to finalize an error into:
    // without this catch the failure is console-only and the user gets silence
    // (PRD §10 "never silent").
    let runId: number;
    try {
      runId = await getOrCreateRun(msg.channel, msg.externalId, msg.personaId, {
        model: this.config.defaultModel,
        authorId: msg.authorId,
      });
      runId = await this.guardLongThread(msg, runId);
    } catch (err) {
      console.error("[pipe] failed to open the conversation:", err);
      await this.channel
        .send(msg.externalId, `⚠️ I couldn't start a turn here: ${describe(err)}`, msg.replyToken)
        .catch(() => {});
      return;
    }

    // 2b. 👀 ack (PRD §6). Fired 5s into the turn — we cannot know in advance
    // that a reply will be slow, so we start the clock and let it prove itself.
    // Deliberately minimal: one reaction on the user's own message, removed
    // when the turn ends, and every failure swallowed. A missing "Add
    // Reactions" permission must never cost the user their answer.
    // The threshold is TASK_ORCH_PIPE_ACK_MS (default 5s, PRD §6: "> ~5s"). We
    // cannot know in advance that a reply will be slow, so we start the clock
    // and let the turn prove itself.
    const ackAfterMs = appConfig.pipe.ackAfterMs;
    let acked = false;
    const ackTimer = msg.messageId && ackAfterMs > 0
      ? setTimeout(() => {
          acked = true;
          void this.channel
            .react?.(msg.externalId, msg.messageId!, ACK_REACTION)
            .catch(() => {});
        }, ackAfterMs)
      : undefined;
    const clearAck = () => {
      if (ackTimer) clearTimeout(ackTimer);
      if (acked && msg.messageId) {
        void this.channel.unreact?.(msg.externalId, msg.messageId, ACK_REACTION).catch(() => {});
      }
    };

    // 3. Open the streaming draft and run the turn.
    let draft;
    try {
      draft = await this.channel.openDraft(msg.externalId, "…", msg.replyToken);
    } catch (err) {
      console.error("[pipe] failed to open draft:", err);
      clearAck();
      await this.channel.send(msg.externalId, `⚠️ ${describe(err)}`, msg.replyToken).catch(() => {});
      return;
    }

    // Transcript fed by live progress (bus and/or generator frames, see below):
    // the only source of incremental progress and of partial output when a
    // turn is stopped.
    const liveBuilder = new TranscriptBuilder();
    const abort = new AbortController();
    let lastEdit = 0;
    // Serializes throttled draft edits: each edit is chained onto the previous
    // one so a slow earlier edit (e.g. a rate-limit retry) can never complete
    // out of order and clobber a newer edit — or, worse, the finalized answer.
    // finalizeWith awaits the chain tail before writing.
    let pendingEdit: Promise<void> = Promise.resolve();

    // Mid-stream edit: only the first chunk (Discord rate-limits edits + caps
    // messages at 2000 chars). Throttled by the caller.
    const updateDraft = async (text: string) => {
      await draft.update(chunkForDiscord(text || "…")[0]);
    };

    // Final flush: finalize the draft with the first chunk, then deliver any
    // overflow as follow-up messages. Once the first chunk is finalized the
    // answer is visible to the user — a later overflow-send failure (thread
    // locked, Missing Access, network) must NOT re-finalize the draft with an
    // error and destroy what was already delivered; we log and move on.
    const finalizeWith = async (text: string) => {
      const chunks = chunkForDiscord(text || "(no output)");
      await draft.finalize(chunks[0]);
      // This is now the persona's latest message here — the only one a 👍/👎
      // may answer (see reactedToOwnLatest). Overflow chunks below are part of
      // the same answer; the FIRST chunk is the one a reader reacts to.
      this.noteOwnMessage(key, draft.messageId);
      for (const extra of chunks.slice(1)) {
        try {
          await this.channel.send(msg.externalId, extra);
        } catch (err) {
          console.error("[pipe] overflow send failed (answer already delivered):", err);
        }
      }
    };

    // Live streaming has two sources, and which one actually carries progress
    // depends on the deploy mode:
    //   - Dev/in-process mode: runs.sendMessageToRun delegates to runs.append,
    //     whose generator yields its SDK envelopes only *after* the turn ends
    //     (and none at all after an abort) — so consuming the generator alone
    //     never streams progress there. The running turn does emit every
    //     envelope in real time on a per-run event bus, so we subscribe to
    //     that and edit the draft on a throttle.
    //   - Containerized/relay deploy: the turn runs in a worker, so runs.isLive
    //     (in-process state) is never true and the bus never attaches — but
    //     runs.sendMessageToRun's relay path DOES yield sdk frames
    //     incrementally as the worker produces them. So we *also* push every
    //     sdk frame the generator itself yields into the live builder below,
    //     through the same throttle. In dev mode this is a no-op until the very
    //     end (one extra, harmless late draft update right before finalize);
    //     in relay mode it's the only source of mid-stream progress.
    const pushLive = (env: RunEnvelope) => {
      liveBuilder.push(env);
      const now = Date.now();
      if (now - lastEdit >= this.config.editThrottleMs) {
        lastEdit = now;
        const text = liveBuilder.text();
        pendingEdit = pendingEdit
          .then(() => updateDraft(text))
          .catch(() => {}); // swallow mid-stream edit failures
      }
    };
    const onBusEvent = (event: unknown) => {
      const e = event as { type?: string; sdk?: RunEnvelope };
      if (e.type !== "sdk" || !e.sdk) return;
      pushLive(e.sdk);
    };

    let settled = false;
    // Flips true on the generator's first sdk frame — proof the relay is
    // already the live source, so the bus (which will never attach in that
    // mode) isn't worth polling for any further.
    let sawGeneratorFrame = false;
    let unsubscribe: () => void = () => {};
    const attach = (async () => {
      const deadline = Date.now() + ATTACH_POLL_TIMEOUT_MS;
      while (!settled && !sawGeneratorFrame && !runs.isLive(runId) && Date.now() < deadline) {
        await delay(20);
      }
      if (!settled && !sawGeneratorFrame && runs.isLive(runId)) {
        unsubscribe = runs.subscribe(runId, onBusEvent);
      }
    })();

    // The generator carries the terminal signal and, on normal completion, the
    // authoritative (complete) envelope list. On abort it yields only `done`
    // with no envelopes — then the partial transcript accumulated from the live
    // bus is all we have to show.
    //
    // PLACEMENT (M4 check, nothing to change): the call chain is unchanged —
    // chat.runChat → runs.sendMessageToRun → (isServerRuntimeRun) append().
    // A persona conversation is a server-runtime run, so sendMessageToRun takes
    // the in-process append branch RIGHT HERE, in the pipe process, even on a
    // deployment with a remote runner configured. That is what makes the
    // dev-mode shape (bus-carried progress, envelopes batched at the end) the
    // normal shape for persona bots rather than the relay shape.
    const finalEnvelopes: RunEnvelope[] = [];
    let errorText: string | null = null;
    try {
      for await (const ev of chat.runChat({
        chatId: runId,
        userText: msg.text,
        abort,
        author: msg.authorLabel, // e.g. "discord:mgeorgi" — provenance on tasks/notes
      })) {
        if (ev.type === "sdk" && ev.sdk) {
          finalEnvelopes.push(ev.sdk);
          sawGeneratorFrame = true;
          pushLive(ev.sdk); // relay mode: this IS the live progress signal
        } else if (ev.type === "error") {
          errorText = ev.error ?? "agent error";
          break;
        } else if (ev.type === "done") {
          break;
        }
      }
    } catch (err) {
      console.error("[pipe] turn failed:", err);
      errorText = describe(err);
    } finally {
      settled = true;
      await attach.catch(() => {});
      unsubscribe();
      clearAck();
    }

    if (errorText !== null) {
      await draft.finalize(`⚠️ ${errorText}`).catch(() => {});
      this.noteOwnMessage(key, draft.messageId);
      return;
    }

    // Prefer the generator's complete envelope list for the final render; fall
    // back to whatever the live bus captured (the abort case, where the
    // generator yielded no envelopes but partial output still reached the bus).
    let finalText: string;
    if (finalEnvelopes.length > 0) {
      const finalBuilder = new TranscriptBuilder();
      for (const env of finalEnvelopes) finalBuilder.push(env);
      finalText = finalBuilder.text();
    } else {
      finalText = liveBuilder.text();
    }
    // Ensure any throttled mid-stream edit still in flight settles before we
    // finalize, so the final answer is always the last write to the draft.
    await pendingEdit;
    await finalizeWith(finalText).catch((err) => {
      console.error("[pipe] final flush failed:", err);
    });
  }
}
