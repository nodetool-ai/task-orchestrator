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
 * authoritative assistant text + a single collapsed tool-call counter when the
 * message closes. Consecutive tool calls (within a message or across messages
 * with no text between them) collapse into one `🔧 N tools called` line so the
 * Discord transcript stays compact.
 */
export class TranscriptBuilder {
  /** Finalized assistant text blocks and tool-call summary lines, in order. */
  private parts: string[] = [];
  /** In-progress stream_text delta buffer (cleared when the message closes). */
  private streaming = "";
  /** Count of consecutive tool calls not yet flushed into `parts`. */
  private pendingTools = 0;

  push(env: RunEnvelope): void {
    switch (env.type) {
      case "stream_text":
        this.streaming += env.text;
        break;
      case "assistant": {
        // A complete assistant message: drop any partial stream buffer, then
        // record the text and accumulate the tool count.
        this.streaming = "";
        const blocks = env.message.content as SdkContentBlock[];
        const text = assistantText(blocks);
        if (text) {
          this.flushPendingTools();
          this.parts.push(convertMarkdownTables(text));
        }
        this.pendingTools += toolUses(blocks).length;
        break;
      }
      case "result":
        if (env.is_error && env.result) {
          this.flushPendingTools();
          this.parts.push(`⚠️ ${env.result}`);
        }
        break;
      // stream_thinking / system(init) / user(tool_result): not shown inline.
    }
  }

  /** Current full transcript (finalized parts + live pending-tool count + stream tail). */
  text(): string {
    const tail = this.streaming.trim();
    const tools = this.pendingTools ? toolCountLine(this.pendingTools) : "";
    return [...this.parts, tools, tail].filter(Boolean).join("\n\n").trim();
  }

  private flushPendingTools(): void {
    if (!this.pendingTools) return;
    this.parts.push(toolCountLine(this.pendingTools));
    this.pendingTools = 0;
  }
}

/** Render the collapsed tool counter — singular vs plural. */
function toolCountLine(n: number): string {
  return `> 🔧 ${n === 1 ? "1 tool called" : `${n} tools called`}`;
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

/**
 * Convert GitHub-flavored markdown tables into Discord-renderable bullet lists.
 * Discord has no table syntax, so a table sent verbatim shows up as broken raw
 * `| ... |` text. We turn each body row into a bullet: the first cell is bolded
 * as the row label, the remaining cells become `Header: value` pairs joined by
 * `·`. Single-column tables become a plain bullet list. Non-table text is
 * returned unchanged.
 */
export function convertMarkdownTables(text: string): string {
  if (!text.includes("|")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  const isSeparator = (line: string) =>
    /\|/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    const sep = lines[i + 1];
    // A table is a header row with pipes, immediately followed by a separator.
    if (header.includes("|") && sep !== undefined && isSeparator(sep)) {
      const headers = cells(header);
      let j = i + 2;
      const rows: string[] = [];
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        const c = cells(lines[j]);
        if (c.length === 1) {
          rows.push(`- ${c[0]}`);
        } else {
          const rest = c
            .slice(1)
            .map((v, k) => `${headers[k + 1] ?? ""}: ${v}`)
            .join(" · ");
          rows.push(`- **${c[0]}** · ${rest}`);
        }
        j++;
      }
      if (rows.length) {
        out.push(...rows);
        i = j - 1;
        continue;
      }
    }
    out.push(header);
  }
  return out.join("\n");
}
