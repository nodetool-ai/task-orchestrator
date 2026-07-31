// lib/pipe/types.ts
//
// Neutral channel-bridge interfaces. This is a faithful port of the claude-pipe
// architecture (github.com/georgi/claude-pipe): a pluggable Channel abstraction
// feeds inbound messages to an agent loop, which drives the existing
// task-orchestrator agent runtime (lib/chat.ts → lib/runs.ts) and streams the
// reply back by editing a single "draft" message in place.
//
// The interfaces here are deliberately backend/SDK-agnostic and free of any
// channel-specific types (e.g. discord.js stays inside lib/pipe/channels/*),
// so the agent loop and command handler never import a transport library.

/** A message arriving from a channel (already access-checked by the adapter). */
export interface InboundMessage {
  /** Stable channel name, e.g. "discord". Matches the session-store key. */
  channel: string;
  /** Conversation key within the channel: a DM channel id or guild channel/thread id. */
  externalId: string;
  /** Raw user text (self-mentions stripped by the adapter). */
  text: string;
  /** Channel-native author id (e.g. Discord user id). For allowlist + logging. */
  authorId: string;
  /** Human-readable author label, e.g. "discord:mgeorgi". Passed as runs.append author. */
  authorLabel: string;
  /**
   * The persona whose bot received this message (design §1). One pipe process
   * runs N gateway clients — this is the dimension that keeps two personas in
   * the SAME Discord channel on separate conversations (channel_threads is
   * unique on channel + external_id + persona_id).
   */
  personaId: string;
  /**
   * True when this arrived in a DM rather than a guild channel/thread. Gates
   * `/link` (a bearer token must never be pasted in a guild, design §6) and the
   * onboarding / not-enabled replies (PRD §10: always silent in guilds).
   */
  isDirectMessage: boolean;
  /** Channel-native display handle (e.g. the Discord username), stored as the
   *  channel_identities label at `/link` time. */
  authorName?: string;
  /**
   * Opaque, single-use claim on a transport-level reply slot owned by THIS
   * message (M4 review F4). Discord sets it to the id of the deferred slash
   * interaction that produced the message: the first outbound write for this
   * turn — and only for this turn — is delivered as that interaction's reply.
   *
   * Why a claim rather than "the pending interaction for this channel": two
   * slash commands can be in flight in one channel at once, and an ordinary
   * message turn running alongside them must never steal a command's deferred
   * reply (which would leave the command showing "the application did not
   * respond" and post the wrong text to the wrong user). The claim travels with
   * the message it belongs to, so ownership is explicit instead of ambient.
   */
  replyToken?: string;
  /**
   * Channel-native id of the message this inbound came from, when it has one.
   * Used for the 👀 ack (react on the user's own message while a slow turn
   * runs) — absent for slash interactions, which is fine: a command that
   * deferred already shows "thinking…".
   */
  messageId?: string;
  /**
   * Set when this message was produced by a REACTION rather than typing (PRD
   * §6, "reactions as input"). The adapter still fills `text` with the
   * equivalent typed input ("/stop", "yes", "no") so the normal path applies,
   * but the loop needs the extra context to decide whether the reaction means
   * anything here at all — a 👍 is only "yes" when the persona actually asked
   * something, and an ❌ on a relay BREADCRUMB is a run cancel rather than a
   * turn interrupt.
   */
  reaction?: {
    /** The emoji as its unicode name, e.g. "👍". */
    emoji: string;
    /** Id of the message that was reacted to. */
    messageId: string;
    /** True when the reacted-to message was posted by this bot. */
    ownMessage: boolean;
  };
}

/** Per-write options. Today: the one place mentions are deliberately allowed. */
export interface OutboundOptions {
  /**
   * Channel-native user ids this ONE message may ping. The transport keeps its
   * blanket mention suppression for everything else, so a mention is always an
   * explicit, per-message decision rather than an ambient capability.
   */
  mentionUsers?: string[];
}

/**
 * A live, editable message in a channel — the streaming draft. Returned by
 * Channel.openDraft and held by the agent loop to push incremental updates.
 */
export interface OutboundDraft {
  /** Replace the full text of this draft (in-place edit). */
  update(text: string): Promise<void>;
  /**
   * Final flush; same as update but marks the draft done (no more edits).
   *
   * `opts.mentionUsers` opts THIS write — and only this write — out of the
   * client-wide mention suppression, for the listed channel-native user ids. It
   * exists for the milestone @-mention (PRD §9): a persona's own "your PR is
   * green" narration pings the thread's owner. Breadcrumbs and ordinary replies
   * pass nothing and stay mention-free.
   */
  finalize(text: string, opts?: OutboundOptions): Promise<void>;
  /**
   * Channel-native id of the message backing this draft, when there is one.
   * Absent for a draft delivered as a deferred interaction reply (an
   * interaction response has no id the gateway will report reactions against).
   * The relay uses it to resolve an ❌ reaction back to the run a breadcrumb is
   * about (lib/pipe/relay.ts).
   */
  readonly messageId?: string;
}

/** The neutral interface every channel adapter implements. */
export interface Channel {
  /** Stable name; matches InboundMessage.channel and the session-store key. */
  readonly name: string;
  /** Connect + begin emitting inbound messages. Resolves once ready. */
  start(): Promise<void>;
  /** Disconnect cleanly. */
  stop(): Promise<void>;
  /** Register the inbound callback. The manager wires this to the bus + loop. */
  onMessage(handler: (msg: InboundMessage) => void): void;
  /**
   * Open a new streaming draft in the given conversation and return a handle.
   * `initial` is the placeholder text (e.g. "…"). The adapter sends one message
   * and returns a draft bound to it.
   *
   * `replyToken` is the inbound message's single-use reply claim (see
   * InboundMessage.replyToken): pass it through and the adapter delivers the
   * draft as that interaction's deferred reply; omit it (or pass the token of a
   * turn that already consumed it) and the draft is an ordinary channel message.
   */
  openDraft(externalId: string, initial: string, replyToken?: string): Promise<OutboundDraft>;
  /** Send a standalone (non-streaming) message — used for command replies/errors. */
  send(
    externalId: string,
    text: string,
    replyToken?: string,
    opts?: OutboundOptions
  ): Promise<void>;
  /**
   * Add a reaction to a message (PRD §6: the 👀 "I heard you, this will take a
   * moment" ack). Optional — a transport without reactions simply has no ack.
   */
  react?(externalId: string, messageId: string, emoji: string): Promise<void>;
  /** Remove a reaction this bot added. Best-effort counterpart of `react`. */
  unreact?(externalId: string, messageId: string, emoji: string): Promise<void>;
  /** Rename a thread (the title status machine, PRD J2). Optional. */
  renameThread?(externalId: string, title: string): Promise<void>;
  /** Current title of a thread, or null when it is not a thread / unreadable. */
  threadTitle?(externalId: string): Promise<string | null>;
}

/**
 * One persona bot: a Discord application + token bound to a persona id
 * (design §1). Binding is CONFIG, not schema — tokens are secrets and don't
 * belong in Postgres — so this whole struct comes out of the environment.
 */
export interface PersonaBotConfig {
  /** Persona id this bot speaks as; validated against the personas table at boot. */
  personaId: string;
  /** Gateway bot token (`DISCORD_BOT_TOKEN_<PERSONA_ID>`). Never logged. */
  token: string;
  /** Discord user ids allowed to talk to the bot. Empty => deny all (refused at load). */
  allowedUsers: string[];
  /** Optional channel-id allowlist; empty => any channel the user can reach. */
  allowedChannels: string[];
  /** Discord application id (`DISCORD_APP_ID_<PERSONA_ID>`). Without it the bot
   *  still works over the gateway; only slash-command registration is skipped. */
  applicationId?: string;
  /**
   * True when this bot came from the legacy single-bot `DISCORD_BOT_TOKEN`
   * rather than an explicit `DISCORD_BOT_TOKEN_<PERSONA_ID>`. Config-load only:
   * it lets a boot refusal name `DISCORD_DEFAULT_PERSONA` as the fix, which is
   * the actual lever a legacy deployment has (design §1 / Migration).
   */
  fromLegacyToken?: boolean;
}

/** Back-compat alias: the adapter's config slice IS a persona bot's config. */
export type DiscordConfig = PersonaBotConfig;

export interface PipeConfig {
  /** One entry per persona bot; scripts/pipe.ts builds a (channel, loop) pair each. */
  bots: PersonaBotConfig[];
  /** Provider-qualified default model, e.g. "openai/gpt-5.6-sol". */
  defaultModel: string;
  /** Throttle for in-place draft edits, in ms. */
  editThrottleMs: number;
}

/**
 * A Discord application command, in raw REST shape. Declared here (not with
 * discord.js builders) so lib/pipe/commands.ts — the shared command registry —
 * stays free of transport imports; the adapter PUTs these verbatim.
 */
export interface SlashCommandSpec {
  name: string;
  description: string;
  options?: {
    /** Discord ApplicationCommandOptionType; 3 = STRING (all we need today). */
    type: 3;
    name: string;
    description: string;
    required?: boolean;
  }[];
}
