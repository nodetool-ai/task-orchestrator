// lib/pipe/channel-manager.ts
//
// Owns the channel lifecycle and wires each channel's inbound messages to the
// message bus and the agent loop. Faithful to claude-pipe's manager: start all
// channels, route messages, shut down cleanly.

import { AgentLoop } from "./agent-loop";
import { MessageBus } from "./bus";
import type { Channel, PipeConfig } from "./types";

export class ChannelManager {
  private bus = new MessageBus();

  constructor(
    private channels: Channel[],
    private config: PipeConfig
  ) {}

  async start(): Promise<void> {
    // Wire message handlers before starting any channel, then connect them
    // all concurrently — each channel's start() (e.g. a gateway login) is
    // independent of the others.
    for (const ch of this.channels) {
      const loop = new AgentLoop(ch, this.config);
      ch.onMessage((msg) => {
        // Publish on the bus (fan-in point for future multi-channel use) and
        // dispatch the turn. Fire-and-forget: AgentLoop.handle serialises
        // same-conversation turns on its own per-conversation queue (needed
        // above runs.append's per-run lock — see agent-loop.ts M9a), while
        // distinct conversations still run concurrently.
        this.bus.publishInbound(msg);
        void loop.handle(msg).catch((e) => console.error("[pipe] agent-loop error:", e));
      });
    }
    await Promise.all(
      this.channels.map(async (ch) => {
        await ch.start();
        console.log(`[pipe] channel '${ch.name}' started`);
      })
    );
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.channels.map((c) => c.stop()));
  }
}
