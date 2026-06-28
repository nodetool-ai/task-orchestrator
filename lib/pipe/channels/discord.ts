// lib/pipe/channels/discord.ts
//
// Discord channel adapter — the only place discord.js is imported. Translates
// Discord's gateway events into neutral InboundMessage objects and maps the
// neutral send/draft API onto Discord messages. Access control (the allowlist)
// is enforced here at the boundary so nothing past the adapter ever runs for a
// non-allowlisted user.

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";

import type { Channel, DiscordConfig, InboundMessage, OutboundDraft } from "../types";

/** Minimal structural type for a channel we can post to. */
type Sendable = { send: (content: string) => Promise<Message> };

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
    this.client.on(Events.MessageCreate, (m) => this.onDiscordMessage(m));
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

  private onDiscordMessage(m: Message): void {
    if (m.author.bot) return; // ignore bots (covers our own messages)
    if (!this.cfg.allowedUsers.includes(m.author.id)) return; // allowlist (mandatory)
    if (this.cfg.allowedChannels.length && !this.cfg.allowedChannels.includes(m.channelId)) {
      return;
    }
    const text = stripSelfMention(m.content, this.client.user?.id).trim();
    if (!text) return;
    this.handler?.({
      channel: this.name,
      externalId: m.channelId, // DM channel id OR guild channel/thread id
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
