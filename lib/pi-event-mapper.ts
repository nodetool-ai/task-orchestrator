// lib/pi-event-mapper.ts
//
// Translate pi.dev session events into the internal RunEnvelope shape used
// by lib/runs.ts (persistence, the run-bus SSE stream, and the UI). Keeping
// the envelope shape stable means downstream code is untouched by the SDK
// swap.

export interface RunEnvelopeContentBlock {
  type: string;
  text?: string;
  // (other SDK-specific fields are passed through opaquely)
  [k: string]: unknown;
}

export type RunEnvelope =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: RunEnvelopeContentBlock[] } }
  | { type: "user"; message: { content: RunEnvelopeContentBlock[] } }
  | {
      type: "result";
      result: string | null;
      is_error?: boolean;
      total_cost_usd: number | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    }
  | { type: "stream_text"; text: string }
  | { type: "stream_thinking"; text: string };

interface SessionLite {
  // not used today, kept on the signature for future event-shape extensions
}
interface SessionManagerLite {
  getSessionFile(): string | undefined;
}

/**
 * Map a single pi event to zero or more RunEnvelope rows. Returns [] for
 * events that don't have an envelope equivalent (e.g. low-level lifecycle
 * the runner doesn't surface to consumers).
 */
export function mapPiEvent(
  ev: any,
  _session: SessionLite,
  sessionManager: SessionManagerLite
): RunEnvelope[] {
  switch (ev.type) {
    case "agent_start": {
      const file = sessionManager.getSessionFile();
      if (!file) return [];
      return [{ type: "system", subtype: "init", session_id: file }];
    }
    case "message_end": {
      // Pi emits message_end for every message in the conversation —
      // including user messages and tool results. The runner persists the
      // user message before invoking the SDK, and tool_result blocks come
      // back via tool_execution_end. So only forward true assistant turns.
      if (ev.message?.role !== "assistant") return [];
      const raw = (ev.message?.content as RunEnvelopeContentBlock[] | undefined) ?? [];
      const content = raw.map(normalizeAssistantBlock);
      if (content.length === 0) return [];
      return [{ type: "assistant", message: { content } }];
    }
    case "tool_execution_end": {
      const block: RunEnvelopeContentBlock = {
        type: "tool_result",
        tool_use_id: ev.toolCallId,
        content: ev.result?.content ?? [],
        is_error: ev.isError === true,
      };
      return [{ type: "user", message: { content: [block] } }];
    }
    case "agent_end": {
      const messages = ev.messages as
        | Array<{
            role?: string;
            content?: RunEnvelopeContentBlock[];
            stopReason?: string;
            errorMessage?: string;
          }>
        | undefined;
      const lastText = extractLastText(messages);
      const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      // pi encodes failures/aborts as an assistant message with stopReason
      // "error"/"aborted" (see pi-agent-core handleRunFailure). Derive is_error
      // from it instead of hard-coding false, which would otherwise report
      // every failed pi turn as a clean success to downstream consumers.
      const lastAssistant = [...(messages ?? [])]
        .reverse()
        .find((m) => m?.role === "assistant");
      const isError =
        lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted";
      return [{
        type: "result",
        result: isError && lastAssistant?.errorMessage ? lastAssistant.errorMessage : lastText,
        is_error: isError,
        total_cost_usd: null,
        usage,
      }];
    }
    case "message_update": {
      const sub = ev.assistantMessageEvent;
      if (sub?.type === "text_delta" && typeof sub.delta === "string") {
        return [{ type: "stream_text", text: sub.delta }];
      }
      if (sub?.type === "thinking_delta" && typeof sub.delta === "string") {
        return [{ type: "stream_thinking", text: sub.delta }];
      }
      return [];
    }
    default:
      return [];
  }
}

// Pi's assistant content uses `toolCall` blocks with `arguments`, while the
// rest of the system (UI, persisted history, session log) is built around the
// Claude-SDK shape: `tool_use` blocks with `input`. Normalize here so callers
// downstream don't have to care which SDK produced the event.
function normalizeAssistantBlock(block: RunEnvelopeContentBlock): RunEnvelopeContentBlock {
  if (block?.type === "toolCall") {
    const { type: _t, arguments: args, ...rest } = block as Record<string, unknown>;
    void _t;
    return { ...(rest as RunEnvelopeContentBlock), type: "tool_use", input: args };
  }
  return block;
}

function extractLastText(
  messages: Array<{ content?: RunEnvelopeContentBlock[] }> | undefined
): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = (m.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}
