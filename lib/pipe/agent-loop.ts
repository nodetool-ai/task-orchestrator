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
import * as runs from "@/lib/runs";
import { describe } from "@/lib/utils";
import type { RunEnvelope } from "@/lib/pi-event-mapper";

import { handleCommand } from "./commands";
import { TranscriptBuilder, chunkForDiscord } from "./render";
import { getOrCreateRun } from "./session-store";
import type { Channel, InboundMessage, PipeConfig } from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Bounded wait for the in-process bus to go live (see the attach loop below).
// Only matters in dev mode, where runs.append registers its runner synchronously
// near the start of a turn — a few polls is plenty. In the containerized/relay
// deploy runs.isLive() never returns true, so without a bound this would spin
// for the whole turn; the bound plus the sawGeneratorFrame bailout (below) keep
// it cheap there.
const ATTACH_POLL_TIMEOUT_MS = 3000;

export class AgentLoop {
  // Per-conversation handling chains (see M9a below), keyed by
  // `${msg.channel}:${msg.externalId}`. Cleared once a chain drains so the map
  // never grows past the number of conversations currently in flight.
  private queues = new Map<string, Promise<void>>();

  constructor(
    private channel: Channel,
    private config: PipeConfig
  ) {}

  async handle(msg: InboundMessage): Promise<void> {
    // 1. Slash-command interception (before any LLM call, and BEFORE the
    // per-conversation queue below). Commands run immediately, out of band:
    // /stop's whole point is interrupting a turn that's already in flight, so
    // it must never wait behind the very turn it's trying to kill.
    if (msg.text.trim().startsWith("/")) {
      const result = await handleCommand(msg, this.config);
      if (result.handled) {
        if (result.reply) await this.channel.send(msg.externalId, result.reply);
        return; // command consumed the message
      }
      // else fall through: an unrecognized "/x" is treated as a normal prompt,
      // so it enqueues below like any other message.
    }

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
    const key = `${msg.channel}:${msg.externalId}`;
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

  private async runTurn(msg: InboundMessage): Promise<void> {
    // 2. Resolve or create the chat run for this conversation.
    const runId = await getOrCreateRun(msg.channel, msg.externalId, { model: this.config.defaultModel });

    // 3. Open the streaming draft and run the turn.
    let draft;
    try {
      draft = await this.channel.openDraft(msg.externalId, "…");
    } catch (err) {
      console.error("[pipe] failed to open draft:", err);
      await this.channel.send(msg.externalId, `⚠️ ${describe(err)}`).catch(() => {});
      return;
    }

    // Transcript fed by live progress (bus and/or generator frames, see below):
    // the only source of incremental progress and of partial output when a
    // turn is stopped.
    const liveBuilder = new TranscriptBuilder();
    const abort = new AbortController();
    let lastEdit = 0;
    // Tracks the most recent in-flight throttled draft edit. finalizeWith awaits
    // it first so a mid-stream edit can never land AFTER finalize and clobber
    // the finalized answer.
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
        pendingEdit = updateDraft(liveBuilder.text()).catch(() => {}); // swallow mid-stream edit failures
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
    }

    if (errorText !== null) {
      await draft.finalize(`⚠️ ${errorText}`).catch(() => {});
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
