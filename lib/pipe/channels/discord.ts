// lib/pipe/channels/discord.ts
//
// Discord channel adapter — the only place discord.js is imported. Translates
// Discord's gateway events into neutral InboundMessage objects and maps the
// neutral send/draft API onto Discord messages. Access control (the allowlist)
// is enforced here at the boundary so nothing past the adapter ever runs for a
// non-allowlisted user.
//
// One instance per PERSONA BOT (design §1): the pipe process runs N independent
// gateway clients, and every message this adapter emits is stamped with its
// persona id — the dimension that keeps two personas in one channel on separate
// conversations.
//
// Three inbound shapes converge on the same InboundMessage: gateway messages,
// registered application ("slash") commands, and the ❌ reaction (a pre-queue
// interrupt, routed as "/stop"). An interaction is deferred, its options
// flattened back into "/name arg" text, and the pending interaction is stashed
// under a single-use claim carried on the message it belongs to, so the first
// outbound write of THAT turn goes out as the deferred reply (see
// pendingInteractions / InboundMessage.replyToken below).
//
// WHERE A PERSONA LISTENS (PRD §6, design §1) — enforced in onDiscordMessage:
//   • DM                        → always.
//   • guild channel             → only when @-mentioned (then auto-threaded).
//   • thread the bot itself made → always, no re-mention needed.
//   • anything else             → ignored, silently.
// The mention requirement is what keeps two persona bots sitting in one channel
// from both answering an unaddressed message.

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type ThreadChannel,
  type User,
} from "discord.js";

import { SLASH_COMMANDS, commandNameOf, isConversationScopedCommand } from "../commands";
import {
  ACK_REACTION,
  INPUT_REACTIONS,
  NO_REACTION,
  STOP_REACTION,
  YES_REACTION,
} from "../reactions";
import { recentThreadIds } from "../session-store";
import type { Channel, InboundMessage, OutboundDraft, PersonaBotConfig } from "../types";

/** Minimal structural type for a channel we can post to. */
type Sendable = { send: (content: string) => Promise<Message> };

/** Top-level channel types we can spin a new thread off of. */
const THREADABLE = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);

/** PRD §10: the one-and-only reply a non-allowlisted user ever gets, in DM. */
export const NOT_ENABLED =
  "I'm not enabled for you — ask the operator to add your Discord account to the allowlist.";

// The reaction vocabulary itself lives in lib/pipe/reactions.ts (transport-free
// so the agent loop can share it); re-exported here for the existing importers.
export { ACK_REACTION, NO_REACTION, STOP_REACTION, YES_REACTION };

/**
 * Discord API error codes we treat as "this interaction is gone": the 15-minute
 * webhook token expired (10062 Unknown interaction) or something already
 * consumed it (40060 Interaction has already been acknowledged). Either way the
 * reply must fall back to an ordinary channel send rather than throw away the
 * turn's output.
 */
function isDeadInteraction(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 10062 || code === 40060;
}

/**
 * Insertion-ordered set with a hard cap — used for the thread ids this bot
 * created. Same tradeoff as OneTimeNotices: a fixed memory cost, and a forgotten
 * id just falls back to the authoritative check (thread.ownerId).
 */
export class BoundedIdSet {
  private ids = new Set<string>();
  constructor(private max = 2000) {}
  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/**
 * Bounded "have I already told this user?" memory, so the not-enabled reply
 * fires exactly once per user (PRD §10: "Never repeats").
 *
 * TRADEOFF, deliberate: this is per-process and in-memory. A pipe restart
 * forgets, so a persistent stranger can elicit one more reply per restart —
 * accepted because the alternative (a DB table of people who aren't users) is
 * an unbounded write surface reachable by anyone who can DM the bot, which is a
 * worse deal than an occasional duplicate line. The cap keeps the memory a
 * fixed cost no matter how many strangers show up; eviction is insertion-
 * ordered (Set preserves insertion order), which for this purpose is as good as
 * LRU.
 */
export class OneTimeNotices {
  private seen = new Set<string>();
  constructor(private max = 500) {}
  /** True the first time an id is presented, false afterwards (until evicted). */
  take(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

export class DiscordChannel implements Channel {
  readonly name = "discord";
  /** The persona this bot speaks as; stamped on every inbound message. */
  readonly personaId: string;
  private client: Client;
  private handler?: (msg: InboundMessage) => void;
  private notices = new OneTimeNotices();
  /**
   * Deferred slash-command interactions awaiting their first outbound message,
   * keyed by INTERACTION ID. Discord requires the FIRST response to a command to
   * go through the interaction (an ordinary channel send leaves it showing "the
   * application did not respond"), so openDraft and send consume the entry named
   * by the turn's replyToken and use editReply for chunk one; everything after
   * that is a normal channel send.
   *
   * Keyed by interaction id, NOT by channel id (M4 review F4): a channel-keyed
   * map is ambient state that whichever turn writes first consumes — two
   * concurrent slash commands in one channel cross their replies, and an
   * ordinary message that happens to run alongside a command eats the command's
   * deferred reply. The id is handed to exactly one InboundMessage as its
   * `replyToken`, so the claim is explicit and single-use.
   */
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>();
  /**
   * Thread ids this bot created (auto-thread). The authoritative "is this my
   * thread?" check is `thread.ownerId === me`; this is the cheap path that
   * avoids a fetch, and stays correct if a thread's owner is unreadable.
   */
  private ownThreads = new BoundedIdSet();
  /**
   * Most recent auto-thread per parent channel (M4 review F8). A slash command
   * invoked in the PARENT channel almost always means "the conversation we're
   * having in the thread over there", so /stop, /status and /whoami resolve to
   * it. Per-process and best-effort: after a restart the lookup falls back to
   * the parent channel id, which is the pre-F8 behavior.
   *
   * M5: this is now a CACHE in front of channel_threads, not the only record.
   * On a miss (a restart, or a thread this process never opened)
   * resolveParentConversation walks the persona's recent conversation ids from
   * the DB and asks Discord which of them hangs off this channel — so the
   * resolution survives a restart, and text commands typed in the parent get
   * the same treatment as slash commands instead of opening a new thread.
   */
  private lastThreadByParent = new Map<string, string>();

  constructor(private cfg: PersonaBotConfig) {
    this.personaId = cfg.personaId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal
        GatewayIntentBits.DirectMessages,
        // ❌-as-stop (PRD §6). Reactions are their own intents, and a reaction on
        // a message the bot never cached arrives partial — hence Partials below.
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction], // DMs + uncached reactions
      // Never let agent-generated text ping anyone: suppress @everyone/@here and
      // user/role mentions on every outbound send + edit. The bridge never
      // intentionally mentions, so a blanket default is safe.
      allowedMentions: { parse: [] },
    });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (m) => {
      void this.onDiscordMessage(m).catch((err) =>
        console.error(`[pipe:${this.personaId}] message handler error:`, err)
      );
    });
    this.client.on(Events.InteractionCreate, (i) => {
      if (!i.isChatInputCommand()) return;
      void this.onInteraction(i).catch((err) =>
        console.error(`[pipe:${this.personaId}] interaction handler error:`, err)
      );
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.onReactionAdd(reaction, user).catch((err) =>
        console.error(`[pipe:${this.personaId}] reaction handler error:`, err)
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (c) => {
        console.log(`[pipe:${this.personaId}] discord logged in as ${c.user.tag}`);
        resolve();
      });
      this.client.login(this.cfg.token).catch(reject);
    });
    await this.registerSlashCommands();
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /**
   * Idempotent bulk PUT of this bot's application commands (PRD §7). Discord
   * treats the payload as the complete desired set, so re-running it on every
   * boot converges — no diffing, and no leftovers from an earlier surface.
   *
   * Skipped with a log line when the bot has no DISCORD_APP_ID_<PERSONA_ID>: the
   * gateway (text-command) path works without it, and failing boot over a
   * missing convenience would be the wrong trade. A registration FAILURE is
   * likewise logged rather than fatal — the bot is already logged in and
   * useful, and the usual cause (a stale or wrong app id) is fixable without
   * taking the other bots in this process down.
   */
  private async registerSlashCommands(): Promise<void> {
    if (!this.cfg.applicationId) {
      console.log(
        `[pipe:${this.personaId}] no DISCORD_APP_ID for this bot — skipping slash-command ` +
          "registration (text commands still work)"
      );
      return;
    }
    try {
      const rest = new REST({ version: "10" }).setToken(this.cfg.token);
      await rest.put(Routes.applicationCommands(this.cfg.applicationId), {
        body: SLASH_COMMANDS,
      });
      console.log(`[pipe:${this.personaId}] registered ${SLASH_COMMANDS.length} slash commands`);
    } catch (err) {
      console.error(`[pipe:${this.personaId}] slash-command registration failed:`, err);
    }
  }

  /**
   * A registered application command. Deferred immediately (Discord's 3-second
   * ack window is far shorter than a command that has to touch the DB), then
   * flattened into the same "/name args" text the gateway path produces, so
   * there is exactly one command implementation.
   */
  private async onInteraction(i: ChatInputCommandInteraction): Promise<void> {
    if (!this.cfg.allowedUsers.includes(i.user.id)) {
      // Ephemeral so a guild channel stays clean. Unlike the gateway path this
      // cannot be silent: an interaction MUST get a response.
      await i.reply({ content: NOT_ENABLED, ephemeral: true }).catch(() => {});
      return;
    }
    const gateId = i.channel?.isThread() ? i.channel.parentId ?? i.channelId : i.channelId;
    if (this.cfg.allowedChannels.length && !this.cfg.allowedChannels.includes(gateId)) {
      await i.reply({ content: "I'm not enabled in this channel.", ephemeral: true }).catch(() => {});
      return;
    }

    // /link and /whoami both print account-identifying material (the token's
    // owner, i.e. the linked email), so their deferred replies are ephemeral —
    // visible to the invoker only. The /link option value is never logged.
    const ephemeral = i.commandName === "link" || i.commandName === "whoami";
    await i.deferReply({ ephemeral });
    // The claim: this interaction is owned by exactly the message emitted below.
    this.pendingInteractions.set(i.id, i);

    const args = i.options.data
      .map((o) => (o.value === undefined || o.value === null ? "" : String(o.value)))
      .filter(Boolean)
      .join(" ");
    const text = `/${i.commandName}${args ? ` ${args}` : ""}`;

    this.handler?.({
      channel: this.name,
      externalId: await this.resolveCommandConversation(i),
      text,
      authorId: i.user.id,
      authorLabel: `discord:${i.user.username}`,
      authorName: i.user.username,
      personaId: this.personaId,
      isDirectMessage: i.guildId == null,
      replyToken: i.id,
    });
  }

  /**
   * Which conversation a slash command is about (M4 review F8). In a thread or a
   * DM it is that channel. In a guild PARENT channel the user almost certainly
   * means the auto-thread this bot opened off it — `/stop` typed in #dev is
   * aimed at the turn running in the thread below, not at the (usually
   * nonexistent) conversation keyed on #dev itself. Conversation-scoped commands
   * therefore resolve to the most recent such thread when we have one.
   */
  private async resolveCommandConversation(i: ChatInputCommandInteraction): Promise<string> {
    if (i.guildId == null || i.channel?.isThread()) return i.channelId;
    if (!isConversationScopedCommand(i.commandName)) return i.channelId;
    return this.resolveParentConversation(i.channelId);
  }

  /**
   * The conversation a parent guild channel currently stands for: the most
   * recent thread this persona owns underneath it. In-memory cache first (the
   * threads this process opened), then the persona's recent channel_threads
   * rows — the DB knows the conversation ids, and Discord knows which of them
   * is a thread of THIS channel. Falls back to the channel itself, which is the
   * pre-M4 behavior and always safe.
   */
  private async resolveParentConversation(parentChannelId: string): Promise<string> {
    const cached = this.lastThreadByParent.get(parentChannelId);
    if (cached) return cached;
    let candidates: string[];
    try {
      candidates = await recentThreadIds(this.name, this.personaId);
    } catch (err) {
      console.error(`[pipe:${this.personaId}] thread lookup failed:`, err);
      return parentChannelId;
    }
    for (const id of candidates) {
      try {
        const ch = await this.client.channels.fetch(id);
        if (ch?.isThread?.() && (ch as ThreadChannel).parentId === parentChannelId) {
          this.lastThreadByParent.set(parentChannelId, id);
          return id;
        }
      } catch {
        // Deleted/unreachable thread — try the next candidate.
      }
    }
    return parentChannelId;
  }

  private async onDiscordMessage(m: Message): Promise<void> {
    if (m.author.bot) return; // ignore bots (covers our own messages)

    const isDm = m.guildId == null;
    if (!this.cfg.allowedUsers.includes(m.author.id)) {
      // Allowlist (mandatory). PRD §10: silent in guilds; in a DM exactly one
      // "not enabled" reply, ever — a stranger gets an answer instead of a
      // void, without the bot becoming a notification channel on demand.
      if (isDm && this.notices.take(m.author.id)) {
        await this.send(m.channelId, NOT_ENABLED).catch(() => {});
      }
      return;
    }

    // The channel allowlist gates on the PARENT channel for thread messages — a
    // thread's own id is never in the configured list.
    const gateId = m.channel.isThread() ? m.channel.parentId ?? m.channelId : m.channelId;
    if (this.cfg.allowedChannels.length && !this.cfg.allowedChannels.includes(gateId)) {
      return;
    }

    // WHERE A PERSONA LISTENS (PRD §6). A DM is always for this bot. In a guild
    // the bot must be addressed: an @-mention in a channel, or any message in a
    // thread this bot opened (the thread IS the address). Everything else is
    // ignored SILENTLY — no reply, no reaction, no log — which is what keeps two
    // persona bots in one channel from both answering an unaddressed message,
    // and why "both mentioned" is the only way to get both to answer.
    if (!isDm && !(await this.isAddressed(m))) return;

    const text = stripSelfMention(m.content, this.client.user?.id).trim();
    if (!text) return;

    // Auto-thread: a message in a top-level, threadable guild channel spawns a
    // fresh thread, so each conversation is its own session (keyed by the thread
    // id). DMs and messages already inside a thread stay where they are.
    let externalId = m.channelId;
    if (!m.channel.isThread() && THREADABLE.has(m.channel.type)) {
      // A conversation-scoped COMMAND typed in the parent channel is about the
      // thread below, exactly like the slash-command path (F8) — opening a
      // brand-new thread to answer "/stop" would be absurd. Everything else
      // starts a fresh conversation, which is the auto-thread behavior.
      const scoped = commandNameOf(text);
      if (scoped && isConversationScopedCommand(scoped)) {
        this.handler?.({
          channel: this.name,
          externalId: await this.resolveParentConversation(m.channelId),
          text,
          authorId: m.author.id,
          authorLabel: `discord:${m.author.username}`,
          authorName: m.author.username,
          personaId: this.personaId,
          isDirectMessage: isDm,
          messageId: m.id,
        });
        return;
      }
      try {
        const thread = await m.startThread({
          name: threadName(text, m.author.username),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
        externalId = thread.id;
        // Remember it twice over: as "mine" (so later messages in it need no
        // re-mention even if ownerId is unreadable) and as this channel's
        // current conversation (so a slash command in the parent lands here).
        this.ownThreads.add(thread.id);
        this.lastThreadByParent.set(m.channelId, thread.id);
      } catch (err) {
        console.error(
          `[pipe:${this.personaId}] failed to open thread; falling back to channel:`,
          err
        );
      }
    }

    this.handler?.({
      channel: this.name,
      externalId, // DM channel id, existing thread id, or a freshly opened thread id
      text,
      authorId: m.author.id,
      authorLabel: `discord:${m.author.username}`,
      authorName: m.author.username,
      personaId: this.personaId,
      isDirectMessage: isDm,
      messageId: m.id,
    });
  }

  /**
   * Is this guild message addressed to this bot? True for an @-mention, or for
   * any message inside a thread this bot owns.
   */
  private async isAddressed(m: Message): Promise<boolean> {
    if (this.mentionsSelf(m)) return true;
    const ch = m.channel;
    if (ch.isThread()) return await this.ownsThread(ch);
    return false;
  }

  /** True when the message @-mentions this bot's user (roles/@everyone don't count). */
  private mentionsSelf(m: Message): boolean {
    const selfId = this.client.user?.id;
    if (!selfId) return false;
    // mentions.users is authoritative; the raw-content check is the fallback for
    // shapes where the collection isn't populated.
    if (m.mentions?.users?.has?.(selfId)) return true;
    return new RegExp(`<@!?${selfId}>`).test(m.content ?? "");
  }

  /**
   * Does this bot own the thread? `ownerId` (the account that created the
   * thread) is the robust check and survives restarts — the remembered-id set is
   * only a fast path. A thread another bot opened therefore never matches, which
   * is what stops a persona from answering inside a sibling persona's thread.
   */
  private async ownsThread(ch: ThreadChannel): Promise<boolean> {
    const selfId = this.client.user?.id;
    if (!selfId) return false;
    if (ch.ownerId) return ch.ownerId === selfId;
    if (this.ownThreads.has(ch.id)) return true;
    try {
      const fetched = await ch.fetch();
      return fetched.ownerId === selfId;
    } catch {
      return false; // unreadable owner → not ours; silence is the safe default
    }
  }

  /**
   * ❌ on one of this bot's messages = "stop" (PRD §6, pre-queue interrupt). It
   * is deliberately routed as the text "/stop" through the same inbound path as
   * everything else, so there is exactly ONE abort implementation
   * (commands.ts:/stop) rather than a second, parallel one here.
   *
   * M5 adds the other two input reactions, on the same rails: 👍/👎 on one of
   * the bot's own messages become the text "yes"/"no". The adapter deliberately
   * does NOT decide whether that answer is meaningful — whether the persona
   * actually asked a question, and whether an ❌ landed on a relay breadcrumb
   * (cancel a run) rather than on a reply (interrupt the turn) — because both
   * need the run's state. It stamps `reaction` on the message and lets the
   * agent loop decide (lib/pipe/agent-loop.ts).
   */
  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (user.bot) return;
    const emoji = reaction.emoji?.name ?? "";
    const asText = INPUT_REACTIONS.get(emoji);
    if (!asText) return;
    if (!this.cfg.allowedUsers.includes(user.id)) return; // same allowlist as messages

    const message = reaction.message;
    const isDm = message.guildId == null;
    // Only the bot's own messages (breadcrumbs, drafts, replies) and the bot's
    // own conversations count — an ❌ on someone else's message elsewhere is not
    // aimed at this persona.
    const mine = message.author?.id != null && message.author.id === this.client.user?.id;
    const ch = message.channel;
    const inOwnConversation =
      isDm || (ch?.isThread?.() ? await this.ownsThread(ch as ThreadChannel) : false);
    if (!mine && !inOwnConversation) return;

    const gateId = ch?.isThread?.() ? (ch as ThreadChannel).parentId ?? message.channelId : message.channelId;
    if (this.cfg.allowedChannels.length && !this.cfg.allowedChannels.includes(gateId)) return;

    // 👍/👎 only ever mean anything on one of the BOT's own messages — they are
    // an answer to something the persona said. On a user's own message they are
    // ordinary chat reactions between humans and must stay silent.
    if (emoji !== STOP_REACTION && !mine) return;

    const username = "username" in user && user.username ? user.username : user.id;
    this.handler?.({
      channel: this.name,
      externalId: message.channelId,
      text: asText,
      authorId: user.id,
      authorLabel: `discord:${username}`,
      authorName: username,
      personaId: this.personaId,
      isDirectMessage: isDm,
      reaction: { emoji, messageId: message.id, ownMessage: mine },
    });
  }

  /** Add a reaction to a message (the 👀 ack). Best-effort: a missing
   *  "Add Reactions" permission must never break the turn it decorates. */
  async react(externalId: string, messageId: string, emoji: string): Promise<void> {
    const msg = await this.fetchMessage(externalId, messageId);
    await msg?.react(emoji);
  }

  /** Remove one of this bot's own reactions. Best-effort, same reasoning. */
  async unreact(externalId: string, messageId: string, emoji: string): Promise<void> {
    const msg = await this.fetchMessage(externalId, messageId);
    const selfId = this.client.user?.id;
    if (!msg || !selfId) return;
    await msg.reactions?.cache?.get?.(emoji)?.users?.remove?.(selfId);
  }

  private async fetchMessage(externalId: string, messageId: string): Promise<Message | null> {
    try {
      const ch = await this.client.channels.fetch(externalId);
      if (!ch || !ch.isTextBased()) return null;
      return await (ch as unknown as { messages: { fetch(id: string): Promise<Message> } }).messages.fetch(
        messageId
      );
    } catch {
      return null;
    }
  }

  /** Current title of a thread, or null when the channel isn't a thread. */
  async threadTitle(externalId: string): Promise<string | null> {
    try {
      const ch = await this.client.channels.fetch(externalId);
      if (!ch || !ch.isThread()) return null;
      return (ch as ThreadChannel).name ?? null;
    } catch {
      return null;
    }
  }

  /** Rename a thread (the relay's title status machine). */
  async renameThread(externalId: string, title: string): Promise<void> {
    const ch = await this.client.channels.fetch(externalId);
    if (!ch || !ch.isThread()) return;
    await (ch as ThreadChannel).setName(title);
  }

  async openDraft(
    externalId: string,
    initial: string,
    replyToken?: string
  ): Promise<OutboundDraft> {
    const pending = this.takeInteraction(replyToken);
    // The deferred reply IS the draft: editReply replaces its content in place,
    // exactly like editing a message. If the interaction has expired we fall
    // through to an ordinary channel message rather than losing the turn.
    if (pending && (await this.tryEditReply(pending, initial || "…"))) {
      return {
        update: async (text) => {
          await this.tryEditReply(pending, text || "…");
        },
        finalize: async (text) => {
          const done = await this.tryEditReply(pending, text || "(no output)");
          if (!done) await this.sendToChannel(externalId, text || "(no output)");
        },
      };
    }
    const ch = await this.fetchSendable(externalId);
    const sent = await ch.send(initial || "…");
    return {
      // The relay resolves an ❌ reaction on a breadcrumb back to its run by
      // this id, so a plain (non-interaction) draft carries it.
      messageId: sent.id,
      update: async (text) => {
        await sent.edit(text || "…");
      },
      finalize: async (text) => {
        await sent.edit(text || "(no output)");
      },
    };
  }

  async send(externalId: string, text: string, replyToken?: string): Promise<void> {
    const pending = this.takeInteraction(replyToken);
    if (pending && (await this.tryEditReply(pending, text))) return;
    await this.sendToChannel(externalId, text);
  }

  /**
   * Consume the interaction a turn holds a claim on. Returns undefined when the
   * turn has no claim (an ordinary message) or already spent it — so an
   * interaction is answered exactly once, by its own turn.
   */
  private takeInteraction(replyToken?: string): ChatInputCommandInteraction | undefined {
    if (!replyToken) return undefined;
    const pending = this.pendingInteractions.get(replyToken);
    if (!pending) return undefined;
    this.pendingInteractions.delete(replyToken);
    return pending;
  }

  /**
   * Drop a claim without answering it — used when the reply is going out some
   * other way. (The interaction then times out on Discord's side; a caller that
   * has text to deliver should use send/openDraft instead.)
   */
  private forgetInteraction(replyToken?: string): void {
    if (replyToken) this.pendingInteractions.delete(replyToken);
  }

  /**
   * editReply, tolerant of a dead interaction. Returns false (rather than
   * throwing) when Discord says the interaction is unknown or already
   * acknowledged, so the caller can fall back to a plain channel message.
   */
  private async tryEditReply(i: ChatInputCommandInteraction, text: string): Promise<boolean> {
    try {
      await i.editReply(text);
      return true;
    } catch (err) {
      if (!isDeadInteraction(err)) throw err;
      console.warn(
        `[pipe:${this.personaId}] interaction ${i.id} expired before its reply — falling back to a channel message`
      );
      this.forgetInteraction(i.id);
      return false;
    }
  }

  private async sendToChannel(externalId: string, text: string): Promise<void> {
    const ch = await this.fetchSendable(externalId);
    await ch.send(text);
  }

  private async fetchSendable(externalId: string): Promise<Sendable> {
    const ch = await this.client.channels.fetch(externalId);
    if (!ch || !ch.isTextBased() || !("send" in ch)) {
      throw new Error(`Discord channel ${externalId} is not sendable`);
    }
    return ch as unknown as Sendable;
  }
}

/** Remove a leading/embedded mention of the bot from message content. */
function stripSelfMention(content: string, selfId: string | undefined): string {
  if (!selfId) return content;
  return content.replace(new RegExp(`<@!?${selfId}>`, "g"), "");
}

/** Build a Discord thread name from the first message (Discord caps names at 100). */
function threadName(text: string, username: string): string {
  const firstLine = text.split("\n")[0].trim().replace(/\s+/g, " ");
  const base = firstLine || `Chat with ${username}`;
  return base.length > 80 ? base.slice(0, 79) + "…" : base;
}
