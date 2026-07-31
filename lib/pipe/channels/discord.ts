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
// Two inbound shapes converge on the same InboundMessage: gateway messages, and
// registered application ("slash") commands. An interaction is deferred, its
// options flattened back into "/name arg" text, and the pending interaction is
// stashed by channel id so the first outbound chunk goes out as the deferred
// reply (see pendingInteractions below).

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
} from "discord.js";

import { SLASH_COMMANDS } from "../commands";
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
   * keyed by the channel the command was invoked in. Discord requires the FIRST
   * response to a command to go through the interaction (an ordinary channel
   * send leaves it showing "the application did not respond"), so openDraft and
   * send consume the pending entry and use editReply for chunk one; everything
   * after that is a normal channel send.
   */
  private pendingInteractions = new Map<string, ChatInputCommandInteraction>();

  constructor(private cfg: PersonaBotConfig) {
    this.personaId = cfg.personaId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // required to receive DMs
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

    // /link carries a bearer token: keep its deferred reply ephemeral so the
    // confirmation isn't posted publicly. The option value is never logged.
    await i.deferReply({ ephemeral: i.commandName === "link" });
    this.pendingInteractions.set(i.channelId, i);

    const args = i.options.data
      .map((o) => (o.value === undefined || o.value === null ? "" : String(o.value)))
      .filter(Boolean)
      .join(" ");
    const text = `/${i.commandName}${args ? ` ${args}` : ""}`;

    this.handler?.({
      channel: this.name,
      externalId: i.channelId,
      text,
      authorId: i.user.id,
      authorLabel: `discord:${i.user.username}`,
      authorName: i.user.username,
      personaId: this.personaId,
      isDirectMessage: i.guildId == null,
    });
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

    const text = stripSelfMention(m.content, this.client.user?.id).trim();
    if (!text) return;

    // Auto-thread: a message in a top-level, threadable guild channel spawns a
    // fresh thread, so each conversation is its own session (keyed by the thread
    // id). DMs and messages already inside a thread stay where they are.
    let externalId = m.channelId;
    if (!m.channel.isThread() && THREADABLE.has(m.channel.type)) {
      try {
        const thread = await m.startThread({
          name: threadName(text, m.author.username),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
        externalId = thread.id;
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
    });
  }

  async openDraft(externalId: string, initial: string): Promise<OutboundDraft> {
    const pending = this.takeInteraction(externalId);
    if (pending) {
      // The deferred reply IS the draft: editReply replaces its content in
      // place, exactly like editing a message.
      await pending.editReply(initial || "…");
      return {
        update: async (text) => {
          await pending.editReply(text || "…");
        },
        finalize: async (text) => {
          await pending.editReply(text || "(no output)");
        },
      };
    }
    const ch = await this.fetchSendable(externalId);
    const sent = await ch.send(initial || "…");
    return {
      update: async (text) => {
        await sent.edit(text || "…");
      },
      finalize: async (text) => {
        await sent.edit(text || "(no output)");
      },
    };
  }

  async send(externalId: string, text: string): Promise<void> {
    const pending = this.takeInteraction(externalId);
    if (pending) {
      await pending.editReply(text);
      return;
    }
    const ch = await this.fetchSendable(externalId);
    await ch.send(text);
  }

  /** Consume the pending interaction for a channel, if one still owes a reply. */
  private takeInteraction(externalId: string): ChatInputCommandInteraction | undefined {
    const pending = this.pendingInteractions.get(externalId);
    if (!pending) return undefined;
    this.pendingInteractions.delete(externalId);
    return pending;
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
