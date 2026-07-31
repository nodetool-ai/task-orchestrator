// lib/pipe/channel-manager.ts
//
// Owns the channel lifecycle and wires each channel's inbound messages to the
// message bus and the agent loop. Faithful to claude-pipe's manager: start all
// channels, route messages, shut down cleanly.
//
// M5 adds one more source of turns besides the user: the WAKE PUMP. A persona
// conversation that parked on `await_session` / a timer wakes when an inbox
// event lands (child.result, gh.pr.merged, timer.fired), and the resulting
// narration IS the milestone message the thread is waiting for. Nobody is
// holding a draft on that turn, so the pipe drives the wake itself and streams
// it into the thread through the same draft path as a typed message (see
// AgentLoop.wakeConversation).

import { config as appConfig } from "@/lib/config";
import { hasPendingInboxEvents } from "@/lib/inbox";
import { isLive } from "@/lib/runs";

import { AgentLoop, type ReactionResolver } from "./agent-loop";
import { MessageBus } from "./bus";
import { recordWake } from "./metrics";
import { listConversations } from "./session-store";
import type { Channel, PipeConfig } from "./types";

export class ChannelManager {
  private bus = new MessageBus();
  /** persona id → its loop, for the wake pump. */
  private loops = new Map<string, { channel: Channel; loop: AgentLoop }>();
  private pump?: ReturnType<typeof setInterval>;
  private pumping = false;

  constructor(
    private channels: Channel[],
    private config: PipeConfig,
    /** The breadcrumb relay, when one is running: the loop consults it to tell
     *  an ❌ on a breadcrumb (cancel that run) from an ❌ on a reply (interrupt
     *  this turn). Optional so the manager still works without a relay. */
    private relay?: ReactionResolver
  ) {}

  async start(): Promise<void> {
    // Wire message handlers before starting any channel, then connect them
    // all concurrently — each channel's start() (e.g. a gateway login) is
    // independent of the others.
    for (const ch of this.channels) {
      const loop = new AgentLoop(ch, this.config, this.relay);
      const personaId = (ch as { personaId?: string }).personaId;
      if (personaId) this.loops.set(personaId, { channel: ch, loop });
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
    this.startWakePump();
  }

  async stop(): Promise<void> {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
    await Promise.allSettled(this.channels.map((c) => c.stop()));
  }

  /** Poll owned conversations for pending inbox events and drive their turns. */
  private startWakePump(): void {
    const ms = appConfig.pipe.relayPollMs;
    if (ms <= 0 || this.pump) return;
    this.pump = setInterval(() => {
      void this.pumpOnce().catch((err) => console.error("[pipe] wake pump failed:", err));
    }, ms);
    this.pump.unref?.();
  }

  /**
   * One pump pass. Re-entrancy guarded: a wake turn can take a minute, and
   * stacking passes behind the interval would queue duplicate turns on the
   * same conversation (harmless thanks to the server claim, but wasteful).
   */
  async pumpOnce(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const [personaId, { channel, loop }] of this.loops) {
        const conversations = await listConversations(channel.name, personaId);
        for (const conv of conversations) {
          if (isLive(conv.runId)) continue;
          if (!(await hasPendingInboxEvents(conv.runId))) continue;
          // Counted on the DECISION to wake, not on the turn's outcome: a wake
          // that finds nothing to say is still a wake this pump paid for
          // (PRD §11 "wakes per persona").
          recordWake(personaId);
          await loop
            .wakeConversation(conv.externalId, personaId, channel.name)
            .catch((err) => console.error("[pipe] wake failed:", err));
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
