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
            usage?: PiUsage;
          }>
        | undefined;
      const lastText = extractLastText(messages);
      // pi's agent_end is exactly { type:'agent_end', messages } — it carries NO
      // usage field (see pi-agent-core AgentEvent). The real token/cost data lives
      // per AssistantMessage as `usage: {input, output, cacheRead, cacheWrite,
      // cost:{total}}` (pi-ai Usage), so we sum it across the assistant messages
      // here. Reading ev.usage (as before) always yielded undefined, which is why
      // the floor showed tok 0/0 and cost stayed null for every pi run.
      const summed = sumAssistantUsage(messages);
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
        total_cost_usd: summed ? summed.total_cost_usd : null,
        usage: summed
          ? { input_tokens: summed.input_tokens, output_tokens: summed.output_tokens }
          : undefined,
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

// Per-AssistantMessage usage as emitted by pi-ai (types.d.ts `Usage`). Fields are
// typed optional here since we only read what we need off untyped SDK events.
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/**
 * Sum token usage and cost across the assistant messages of an agent_end event.
 * Returns null when no assistant message carried usage, so the caller can keep the
 * "unknown" (null/undefined) envelope semantics rather than reporting a false 0.
 *
 * Decision: `input`/`output` are recorded as the run's input/output token counts and
 * cacheRead/cacheWrite are intentionally NOT folded into them. This mirrors the Claude
 * backend (whose input_tokens likewise excludes cached tokens), so "tok in/out" means
 * the same thing on both backends. Cache traffic is still accounted for in cost, since
 * usage.cost.total already prices cacheRead/cacheWrite.
 */
function sumAssistantUsage(
  messages: Array<{ role?: string; usage?: PiUsage }> | undefined
): { input_tokens: number; output_tokens: number; total_cost_usd: number } | null {
  if (!messages) return null;
  let found = false;
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const m of messages) {
    if (m?.role !== "assistant" || !m.usage) continue;
    found = true;
    input += m.usage.input ?? 0;
    output += m.usage.output ?? 0;
    cost += m.usage.cost?.total ?? 0;
  }
  return found ? { input_tokens: input, output_tokens: output, total_cost_usd: cost } : null;
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
