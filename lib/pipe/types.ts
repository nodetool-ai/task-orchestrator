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
}

/**
 * A live, editable message in a channel — the streaming draft. Returned by
 * Channel.openDraft and held by the agent loop to push incremental updates.
 */
export interface OutboundDraft {
  /** Replace the full text of this draft (in-place edit). */
  update(text: string): Promise<void>;
  /** Final flush; same as update but marks the draft done (no more edits). */
  finalize(text: string): Promise<void>;
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
   */
  openDraft(externalId: string, initial: string): Promise<OutboundDraft>;
  /** Send a standalone (non-streaming) message — used for command replies/errors. */
  send(externalId: string, text: string): Promise<void>;
}

/** Discord-specific config slice. */
export interface DiscordConfig {
  token: string;
  /** Discord user ids allowed to talk to the bot. Empty => deny all (refused at load). */
  allowedUsers: string[];
  /** Optional channel-id allowlist; empty => any channel the user can reach. */
  allowedChannels: string[];
}

export interface PipeConfig {
  discord: DiscordConfig;
  /** Provider-qualified default model, e.g. "anthropic/claude-sonnet-4-6". */
  defaultModel: string;
  /** Throttle for in-place draft edits, in ms. */
  editThrottleMs: number;
}
