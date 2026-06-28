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
        if (text) this.parts.push(convertMarkdownTables(text));
        for (const tu of toolUses(blocks)) {
          const name = prettyToolName(tu.name ?? "tool");
          const args = summarizeInput(tu.input);
          this.parts.push(`> 🔧 ${inlineCode(args ? `${name}(${args})` : name)}`);
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

/**
 * Convert GitHub-flavored markdown tables into Discord-renderable bullet lists.
 * Discord has no table syntax, so a table sent verbatim shows up as broken raw
 * `| ... |` text. We turn each body row into a bullet: the first cell is bolded
 * as the row label, the remaining cells become `Header: value` pairs joined by
 * `\u00b7`. Single-column tables become a plain bullet list. Non-table text is
 * returned unchanged.
 */
export function convertMarkdownTables(text: string): string {
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
            .join(" \u00b7 ");
          rows.push(`- **${c[0]}** \u00b7 ${rest}`);
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

/**
 * Humanize a tool name for display. Builtin tools (Bash, Read, ToolSearch …)
 * pass through unchanged. MCP tools are named `mcp__<server>__<tool>`, often
 * with the server name duplicated inside the tool (e.g.
 * `mcp__task_orch__task_orch__list_repositories`). Strip the `mcp__<server>__`
 * prefix and any duplicated server segment, then render the bare action with
 * underscores as spaces — `list repositories`.
 */
export function prettyToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const segs = name.split("__").filter(Boolean); // ["mcp", server, ...tool]
  if (segs.length < 3) return name;
  const [, server, ...rest] = segs;
  if (rest.length > 1 && rest[0] === server) rest.shift(); // drop duplicated server prefix
  return rest.join(" ").replace(/_/g, " ").trim();
}

/**
 * Wrap text in a Discord inline-code span so its contents render literally —
 * spaces, `__`, and other markdown stay intact. Backticks in the content would
 * close the span early, so swap them for a look-alike.
 */
function inlineCode(s: string): string {
  return "`" + s.replace(/`/g, "ʼ") + "`";
}

/** One-line, truncated summary of a tool-call input for a status line. */
function summarizeInput(input: unknown): string {
  if (input == null) return "";
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return "";
    // Prefer the human-meaningful fields the orchestrator/builtin tools use.
    const key = obj.command ?? obj.path ?? obj.file_path ?? obj.query ?? obj.text;
    s = typeof key === "string" ? key : JSON.stringify(obj);
  } else {
    s = String(input);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}
