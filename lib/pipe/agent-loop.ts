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

import { handleCommand } from "./commands";
import { TranscriptBuilder, chunkForDiscord } from "./render";
import { getOrCreateRun } from "./session-store";
import type { Channel, InboundMessage, PipeConfig } from "./types";

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
    const runId = getOrCreateRun(msg.channel, msg.externalId, { model: this.config.defaultModel });

    // 3. Open the streaming draft and run the turn.
    let draft;
    try {
      draft = await this.channel.openDraft(msg.externalId, "…");
    } catch (err) {
      console.error("[pipe] failed to open draft:", err);
      await this.channel.send(msg.externalId, `⚠️ ${describe(err)}`).catch(() => {});
      return;
    }

    const builder = new TranscriptBuilder();
    const abort = new AbortController();
    let lastEdit = 0;

    // Render the accumulated transcript. Mid-stream we only edit the draft with
    // the first chunk (Discord rate-limits edits + caps messages at 2000 chars);
    // on the final flush we finalize the draft and send any overflow as
    // follow-up messages.
    const flush = async (final: boolean) => {
      const full = builder.text() || (final ? "(no output)" : "…");
      const chunks = chunkForDiscord(full);
      if (final) {
        await draft.finalize(chunks[0]);
        for (const extra of chunks.slice(1)) {
          await this.channel.send(msg.externalId, extra);
        }
      } else {
        await draft.update(chunks[0]);
      }
    };

    try {
      for await (const ev of chat.runChat({
        chatId: runId,
        userText: msg.text,
        abort,
        author: msg.authorLabel, // e.g. "discord:mgeorgi" — provenance on tasks/notes
      })) {
        if (ev.type === "sdk" && ev.sdk) {
          builder.push(ev.sdk);
          const now = Date.now();
          if (now - lastEdit >= this.config.editThrottleMs) {
            lastEdit = now;
            await flush(false).catch(() => {}); // swallow mid-stream edit failures
          }
        } else if (ev.type === "error") {
          await draft.finalize(`⚠️ ${ev.error ?? "agent error"}`).catch(() => {});
          return;
        } else if (ev.type === "done") {
          break;
        }
      }
      await flush(true);
    } catch (err) {
      console.error("[pipe] turn failed:", err);
      await draft.finalize(`⚠️ ${describe(err)}`).catch(() => {});
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
