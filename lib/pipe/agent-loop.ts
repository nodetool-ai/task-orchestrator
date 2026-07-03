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

export class AgentLoop {
  constructor(
    private channel: Channel,
    private config: PipeConfig
  ) {}

  async handle(msg: InboundMessage): Promise<void> {
    // 1. Slash-command interception (before any LLM call).
    if (msg.text.trim().startsWith("/")) {
      const result = await handleCommand(msg, this.config);
      if (result.handled) {
        if (result.reply) await this.channel.send(msg.externalId, result.reply);
        return; // command consumed the message
      }
      // else fall through: an unrecognized "/x" is treated as a normal prompt.
    }

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

    // Transcript fed by the LIVE per-run bus (see below): the only source of
    // incremental progress and of partial output when a turn is stopped.
    const liveBuilder = new TranscriptBuilder();
    const abort = new AbortController();
    let lastEdit = 0;

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

    // Live streaming. runs.append yields its SDK envelopes only *after* the turn
    // ends (and yields none at all after an abort), so consuming the generator
    // alone can never stream progress. The running turn also emits every envelope
    // in real time on a per-run event bus; subscribe to that and edit the draft
    // on a throttle. The bus is created inside runs.append once the turn starts,
    // so we attach as soon as the run goes live and detach when it settles.
    const onBusEvent = (event: unknown) => {
      const e = event as { type?: string; sdk?: RunEnvelope };
      if (e.type !== "sdk" || !e.sdk) return;
      liveBuilder.push(e.sdk);
      const now = Date.now();
      if (now - lastEdit >= this.config.editThrottleMs) {
        lastEdit = now;
        void updateDraft(liveBuilder.text()).catch(() => {}); // swallow mid-stream edit failures
      }
    };

    let settled = false;
    let unsubscribe: () => void = () => {};
    const attach = (async () => {
      while (!settled && !runs.isLive(runId)) await delay(20);
      if (!settled) unsubscribe = runs.subscribe(runId, onBusEvent);
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
    await finalizeWith(finalText).catch((err) => {
      console.error("[pipe] final flush failed:", err);
    });
  }
}
