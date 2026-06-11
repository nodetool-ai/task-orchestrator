// lib/claude-transcript.ts
//
// Map Claude Code session-transcript JSONL entries (the files under
// ~/.claude/projects/<munged-cwd>/<session-id>.jsonl) into the internal
// RunEnvelope shape used by lib/runs.ts. The CLI harness tails the
// transcript file while `claude` runs inside tmux; this module is the
// pure parsing/mapping half so it can be unit-tested without tmux.
//
// Transcript entries are already Claude-shaped (`tool_use` with `input`,
// `tool_result` with `tool_use_id`), so unlike lib/pi-event-mapper.ts no
// block normalization is needed — only filtering:
//   - assistant entries  → assistant envelopes (content passed through)
//   - user entries with tool_result blocks → user envelopes
//   - plain-text user entries → user envelopes, EXCEPT the initial prompt
//     (the runner already persisted it) and local-command noise
//   - everything else (summary, system, file-history-snapshot, sidechain
//     subagent traffic, isMeta skill injections, …) → dropped

import type { RunEnvelope, RunEnvelopeContentBlock } from "./pi-event-mapper";

export interface ParsedChunk {
  entries: unknown[];
  /** Trailing partial line to prepend to the next chunk. */
  carry: string;
}

/**
 * Incremental JSONL parse: prepend the previous call's `carry`, split on
 * newlines, JSON-parse complete lines, and return the trailing partial
 * line (the file may be mid-write) as the new carry.
 */
export function parseTranscriptChunk(chunk: string, carry: string): ParsedChunk {
  const text = carry + chunk;
  const lines = text.split("\n");
  const nextCarry = lines.pop() ?? "";
  const entries: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // A complete line that isn't JSON — corrupt or foreign; skip it.
    }
  }
  return { entries, carry: nextCarry };
}

export interface MapTranscriptOpts {
  /** The prompt the runner submitted — its transcript echo is skipped. */
  initialPrompt: string;
  /** Cross-call uuid dedupe state, owned by the tailer. */
  seenUuids: Set<string>;
}

/**
 * Map one transcript entry to zero or more RunEnvelopes. Stateless apart
 * from the caller-owned uuid set (re-reads after a tail hiccup must not
 * duplicate messages).
 */
export function mapTranscriptEntry(
  entry: unknown,
  opts: MapTranscriptOpts
): RunEnvelope[] {
  if (!entry || typeof entry !== "object") return [];
  const e = entry as Record<string, unknown>;

  if (e.isSidechain === true) return []; // subagent traffic
  if (e.isMeta === true) return []; // skill/system injections

  const uuid = typeof e.uuid === "string" ? e.uuid : null;
  if (uuid) {
    if (opts.seenUuids.has(uuid)) return [];
    opts.seenUuids.add(uuid);
  }

  const message = (e.message ?? null) as { content?: unknown } | null;

  if (e.type === "assistant") {
    const content = Array.isArray(message?.content)
      ? (message!.content as RunEnvelopeContentBlock[])
      : [];
    if (content.length === 0) return [];
    return [{ type: "assistant", message: { content } }];
  }

  if (e.type === "user") {
    const raw = message?.content;

    // Plain-string content: the submitted prompt or text typed by a human
    // who attached to the tmux session.
    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) return [];
      if (text === opts.initialPrompt.trim()) return [];
      // Local slash-command invocations echo as <command-…> XML — noise.
      if (text.startsWith("<command-") || text.includes("<command-name>")) return [];
      return [{ type: "user", message: { content: [{ type: "text", text }] } }];
    }

    if (Array.isArray(raw)) {
      const blocks = raw as RunEnvelopeContentBlock[];
      const toolResults = blocks.filter((b) => b?.type === "tool_result");
      if (toolResults.length > 0) {
        return [{ type: "user", message: { content: toolResults } }];
      }
      const text = blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => (b.text as string).trim())
        .filter(Boolean)
        .join("\n");
      if (!text) return [];
      if (text === opts.initialPrompt.trim()) return [];
      if (text.startsWith("<command-") || text.includes("<command-name>")) return [];
      return [{ type: "user", message: { content: [{ type: "text", text }] } }];
    }

    return [];
  }

  // summary / system / file-history-snapshot / permission-mode / …
  return [];
}
