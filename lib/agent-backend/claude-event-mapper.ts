// lib/agent-backend/claude-event-mapper.ts
//
// Translate Claude Agent SDK messages into the internal RunEnvelope shape. Since
// RunEnvelope was modeled on the Claude SDK in the first place, this is nearly an
// identity map. Returns [] for messages with no envelope equivalent.
//
// session_id is left UNtagged here (pure/testable); the backend prefixes it with
// "claude:" before persisting, mirroring the pi adapter.

import type { RunEnvelope, RunEnvelopeContentBlock } from "../pi-event-mapper";

export function mapClaudeMessage(msg: any): RunEnvelope[] {
  switch (msg?.type) {
    case "system": {
      if (msg.subtype === "init" && msg.session_id) {
        return [{ type: "system", subtype: "init", session_id: msg.session_id }];
      }
      return [];
    }
    case "assistant": {
      const content = (msg.message?.content as RunEnvelopeContentBlock[] | undefined) ?? [];
      if (!Array.isArray(content) || content.length === 0) return [];
      return [{ type: "assistant", message: { content } }];
    }
    case "user": {
      // User messages carry tool_result blocks back from the agent. The user's
      // own prompt is persisted upstream, so only forward tool_result content.
      const content = (msg.message?.content as RunEnvelopeContentBlock[] | undefined) ?? [];
      if (!Array.isArray(content)) return [];
      const toolResults = content.filter((b) => b?.type === "tool_result");
      if (toolResults.length === 0) return [];
      return [{ type: "user", message: { content: toolResults } }];
    }
    case "result": {
      const usage = msg.usage
        ? { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens }
        : undefined;
      const isError = msg.subtype !== "success";
      return [{
        type: "result",
        result: !isError && typeof msg.result === "string" ? msg.result : null,
        is_error: isError,
        total_cost_usd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
        usage,
      }];
    }
    case "stream_event": {
      const ev = msg.event;
      if (ev?.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          return [{ type: "stream_text", text: d.text }];
        }
        if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
          return [{ type: "stream_thinking", text: d.thinking }];
        }
      }
      return [];
    }
    default:
      return [];
  }
}
