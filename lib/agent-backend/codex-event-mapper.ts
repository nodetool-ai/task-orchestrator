// lib/agent-backend/codex-event-mapper.ts
//
// Translate Codex SDK thread events (`@openai/codex-sdk`'s ThreadEvent, the
// JSONL stream `codex exec` emits) into the internal RunEnvelope shape.
//
// RunEnvelope was modeled on the Claude SDK, so unlike claude-event-mapper this
// is a real translation rather than an identity map. Two shape mismatches drive
// the design:
//
//   1. Codex reports work as *items* (command_execution, file_change,
//      mcp_tool_call, …) with a lifecycle — started → updated* → completed —
//      rather than as an assistant tool_use block followed by a tool_result.
//      We map only `item.completed`, and emit BOTH halves of the pair at once:
//      an assistant `tool_use` block and the matching user `tool_result`. That
//      keeps the transcript's tool_use_id pairing intact (the UI and
//      lib/runs.ts persistence both key on it) and never leaves a tool call
//      rendered as perpetually pending.
//   2. Codex has no per-turn cost, only token counts, so `total_cost_usd` is
//      always null here. The run's cost column stays null for codex runs rather
//      than reporting a fabricated 0.
//
// session_id is left UNtagged (pure/testable); the backend prefixes it with
// "codex:" before persisting, mirroring the pi and Claude adapters.

import type { RunEnvelope, RunEnvelopeContentBlock } from "../pi-event-mapper";

/** Context the per-event mapping can't derive on its own. */
export interface CodexMapContext {
  /** Text of the most recent agent_message, used as the turn's result summary
   *  (Codex's turn.completed carries usage only — no final response). */
  lastAgentMessage?: string | null;
}

/** Cap on a tool_result body. Codex hands back the FULL aggregated stdout+stderr
 *  of every command; a `npm ci` or a test run can be megabytes, and each result
 *  becomes an agent_messages row. Truncate the middle so both the command's
 *  opening lines and its (usually decisive) tail survive. */
const MAX_OUTPUT_CHARS = 32_000;

export function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const omitted = text.length - max;
  return (
    text.slice(0, head) +
    `\n\n… [${omitted} characters omitted] …\n\n` +
    text.slice(text.length - tail)
  );
}

function toolUse(id: string, name: string, input: Record<string, unknown>): RunEnvelope {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id: string, text: string, isError = false): RunEnvelope {
  const block: RunEnvelopeContentBlock = {
    type: "tool_result",
    tool_use_id: id,
    content: [{ type: "text", text: truncateOutput(text) }],
    is_error: isError,
  };
  return { type: "user", message: { content: [block] } };
}

/** Map one completed thread item to its envelope pair (or single envelope). */
function mapItem(item: any): RunEnvelope[] {
  switch (item?.type) {
    case "agent_message": {
      const text = typeof item.text === "string" ? item.text : "";
      if (!text) return [];
      return [{ type: "assistant", message: { content: [{ type: "text", text }] } }];
    }
    case "reasoning": {
      // Reasoning summaries stream to the live view but are NOT persisted
      // (lib/runs.ts only writes assistant/user/system/result envelopes), which
      // matches how the floor renders pi's thinking deltas.
      const text = typeof item.text === "string" ? item.text : "";
      return text ? [{ type: "stream_thinking", text }] : [];
    }
    case "command_execution": {
      const command = typeof item.command === "string" ? item.command : "";
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
      const failed = item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
      const exit = item.exit_code != null ? `exit ${item.exit_code}\n` : "";
      return [
        // Canonical "Bash" so lib/builtin-tools renders it like every other
        // harness's shell tool instead of an anonymous wrench.
        toolUse(item.id, "Bash", { command }),
        toolResult(item.id, `${exit}${output}`.trim() || "(no output)", failed),
      ];
    }
    case "file_change": {
      const changes: Array<{ path?: string; kind?: string }> = Array.isArray(item.changes)
        ? item.changes
        : [];
      const summary = changes.map((c) => `${c.kind ?? "update"}: ${c.path ?? "?"}`).join("\n");
      const failed = item.status === "failed";
      return [
        toolUse(item.id, "Edit", { path: changes[0]?.path, changes }),
        toolResult(
          item.id,
          failed ? `Patch failed\n${summary}` : summary || "(no changes)",
          failed
        ),
      ];
    }
    case "mcp_tool_call": {
      // Name it the way every MCP-speaking harness does so humanizeToolName and
      // the UI's tool grouping treat it identically to a Claude MCP call.
      const name = `mcp__${item.server ?? "mcp"}__${item.tool ?? "tool"}`;
      const input =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : {};
      const failed = item.status === "failed" || item.error != null;
      const text = failed
        ? (item.error?.message ?? "MCP tool call failed")
        : renderMcpContent(item.result);
      return [toolUse(item.id, name, input), toolResult(item.id, text, failed)];
    }
    case "web_search": {
      const query = typeof item.query === "string" ? item.query : "";
      return [
        toolUse(item.id, "WebSearch", { query }),
        // Codex returns search results to the model without surfacing them on
        // the item, so close the pair rather than leave it rendered as pending.
        toolResult(item.id, "Results returned to the agent."),
      ];
    }
    case "todo_list": {
      const items: Array<{ text?: string; completed?: boolean }> = Array.isArray(item.items)
        ? item.items
        : [];
      const done = items.filter((t) => t.completed).length;
      return [
        toolUse(item.id, "TodoWrite", { todos: items }),
        toolResult(item.id, `${done}/${items.length} complete`),
      ];
    }
    case "error": {
      // A non-fatal item-level error. Surface it in the transcript; the turn
      // itself is only failed when turn.failed / error arrives.
      const message = typeof item.message === "string" ? item.message : "Unknown error";
      return [{ type: "assistant", message: { content: [{ type: "text", text: `Error: ${message}` }] } }];
    }
    default:
      return [];
  }
}

function renderMcpContent(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "(no content)";
  const text = content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
  return text || "(no content)";
}

/**
 * Map a single Codex thread event to zero or more RunEnvelopes. Returns [] for
 * events with no envelope equivalent (turn.started, and the in-progress item
 * lifecycle events whose terminal `item.completed` we map instead).
 */
export function mapCodexEvent(ev: any, ctx: CodexMapContext = {}): RunEnvelope[] {
  switch (ev?.type) {
    case "thread.started": {
      if (!ev.thread_id) return [];
      return [{ type: "system", subtype: "init", session_id: ev.thread_id }];
    }
    case "item.completed":
      return mapItem(ev.item);
    case "turn.completed": {
      const usage = ev.usage
        ? { input_tokens: ev.usage.input_tokens, output_tokens: ev.usage.output_tokens }
        : undefined;
      return [
        {
          type: "result",
          result: ctx.lastAgentMessage ?? null,
          is_error: false,
          // Codex reports tokens, never a priced total. Leave it unknown rather
          // than claiming a $0 turn.
          total_cost_usd: null,
          usage,
        },
      ];
    }
    case "turn.failed": {
      return [
        {
          type: "result",
          result: ev.error?.message ?? "Turn failed",
          is_error: true,
          total_cost_usd: null,
        },
      ];
    }
    case "error": {
      return [
        {
          type: "result",
          result: typeof ev.message === "string" ? ev.message : "Codex stream error",
          is_error: true,
          total_cost_usd: null,
        },
      ];
    }
    default:
      // turn.started, item.started, item.updated — no envelope equivalent.
      return [];
  }
}
