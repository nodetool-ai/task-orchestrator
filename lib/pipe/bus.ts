// lib/pipe/bus.ts
//
// Message bus — mirrors claude-pipe's inbound queue. A thin EventEmitter-backed
// fan-in so multiple channels can publish inbound messages to a single agent
// loop. We intentionally do NOT add a serialisation queue here: it's a pure
// fan-in for publishing, not the dispatch path. Per-conversation ordering is
// handled by AgentLoop itself (see agent-loop.ts's per-conversation queue),
// so distinct conversations still run concurrently through this bus.

import { EventEmitter } from "node:events";
import type { InboundMessage } from "./types";

export class MessageBus {
  private emitter = new EventEmitter();

  constructor() {
    // A misbehaving channel could attach many short-lived listeners; lift the
    // default cap so Node doesn't print a spurious leak warning.
    this.emitter.setMaxListeners(0);
  }

  /** Publish an inbound message (called by ChannelManager from channel.onMessage). */
  publishInbound(msg: InboundMessage): void {
    this.emitter.emit("inbound", msg);
  }

  /** Subscribe to inbound messages. Returns an unsubscribe fn. */
  onInbound(handler: (msg: InboundMessage) => void): () => void {
    this.emitter.on("inbound", handler);
    return () => this.emitter.off("inbound", handler);
  }
}
