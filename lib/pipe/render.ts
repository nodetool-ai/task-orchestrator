// lib/pipe/render.ts
//
// Turn the RunEnvelope stream from a chat turn into a Discord-renderable
// transcript, and chunk it under Discord's 2000-character message limit. Reuses
// the shared block helpers in lib/sdk-message.ts so rendering stays consistent
// with the web UI.

import { assistantText, toolUses, type SdkContentBlock } from "@/lib/sdk-message";
import type { RunEnvelope } from "@/lib/pi-event-mapper";

/** Discord's hard per-message character limit. */
export const DISCORD_LIMIT = 2000;

/**
 * Running accumulator the agent loop feeds envelopes into. It shows live
 * `stream_text` deltas while a message is in flight, then replaces them with the
 * authoritative assistant text + compact tool-call lines when the message closes.
 */
export class TranscriptBuilder {
  /** Finalized assistant text blocks and tool-call status lines, in order. */
  private parts: string[] = [];
  /** In-progress stream_text delta buffer (cleared when the message closes). */
  private streaming = "";

  push(env: RunEnvelope): void {
    switch (env.type) {
      case "stream_text":
        this.streaming += env.text;
        break;
      case "assistant": {
        // A complete assistant message: drop any partial stream buffer, then
        // record the text and compact tool-call status lines.
        this.streaming = "";
        const blocks = env.message.content as SdkContentBlock[];
        const text = assistantText(blocks);
        if (text) this.parts.push(text);
        for (const tu of toolUses(blocks)) {
          this.parts.push(`> 🔧 ${tu.name ?? "tool"}(${summarizeInput(tu.input)})`);
        }
        break;
      }
      case "result":
        if (env.is_error && env.result) this.parts.push(`⚠️ ${env.result}`);
        break;
      // stream_thinking / system(init) / user(tool_result): not shown inline.
    }
  }

  /** Current full transcript (finalized parts + live stream tail). */
  text(): string {
    const tail = this.streaming.trim();
    return [...this.parts, tail].filter(Boolean).join("\n\n").trim();
  }
}

/**
 * Split a long transcript into <=`limit`-char chunks, preferring paragraph then
 * line then hard-character boundaries so we rarely cut mid-word. Never returns an
 * empty array (returns [""] for empty input so callers always have a first chunk).
 */
export function chunkForDiscord(text: string, limit = DISCORD_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit; // no good boundary — hard split
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks.length ? chunks : [""];
}

/** One-line, truncated summary of a tool-call input for a status line. */
function summarizeInput(input: unknown): string {
  if (input == null) return "";
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // Prefer the human-meaningful fields the orchestrator/builtin tools use.
    const key = obj.command ?? obj.path ?? obj.file_path ?? obj.query ?? obj.text;
    s = typeof key === "string" ? key : JSON.stringify(obj);
  } else {
    s = String(input);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
