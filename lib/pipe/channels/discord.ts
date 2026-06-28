// lib/pipe/channels/discord.ts
//
// Discord channel adapter — the only place discord.js is imported. Translates
// Discord's gateway events into neutral InboundMessage objects and maps the
// neutral send/draft API onto Discord messages. Access control (the allowlist)
// is enforced here at the boundary so nothing past the adapter ever runs for a
// non-allowlisted user.

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
} from "discord.js";

import type { Channel, DiscordConfig, InboundMessage, OutboundDraft } from "../types";

/** Minimal structural type for a channel we can post to. */
type Sendable = { send: (content: string) => Promise<Message> };

/** Top-level channel types we can spin a new thread off of. */
const THREADABLE = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
]);

export class DiscordChannel implements Channel {
  readonly name = "discord";
  private client: Client;
  private handler?: (msg: InboundMessage) => void;

  constructor(private cfg: DiscordConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // required to receive DMs
    });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (m) => {
      void this.onDiscordMessage(m).catch((err) =>
        console.error("[pipe] message handler error:", err)
      );
    });
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (c) => {
        console.log(`[pipe] discord logged in as ${c.user.tag}`);
        resolve();
      });
      this.client.login(this.cfg.token).catch(reject);
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async onDiscordMessage(m: Message): Promise<void> {
    if (m.author.bot) return; // ignore bots (covers our own messages)
    if (!this.cfg.allowedUsers.includes(m.author.id)) return; // allowlist (mandatory)

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
        console.error("[pipe] failed to open thread; falling back to channel:", err);
      }
    }

    this.handler?.({
      channel: this.name,
      externalId, // DM channel id, existing thread id, or a freshly opened thread id
      text,
      authorId: m.author.id,
      authorLabel: `discord:${m.author.username}`,
    });
  }

  async openDraft(externalId: string, initial: string): Promise<OutboundDraft> {
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
