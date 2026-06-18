import { describe, expect, it } from "vitest";
import { mapClaudeMessage } from "../../lib/agent-backend/claude-event-mapper";

describe("mapClaudeMessage", () => {
  it("maps system/init to a system/init envelope (untagged session_id)", () => {
    expect(mapClaudeMessage({ type: "system", subtype: "init", session_id: "sess-1" })).toEqual([
      { type: "system", subtype: "init", session_id: "sess-1" },
    ]);
  });

  it("ignores non-init system messages", () => {
    expect(mapClaudeMessage({ type: "system", subtype: "compact_boundary" })).toEqual([]);
  });

  it("maps an assistant message, passing content blocks through", () => {
    expect(
      mapClaudeMessage({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "tc-1", name: "Read", input: { file_path: "x.ts" } },
          ],
        },
      })
    ).toEqual([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "tc-1", name: "Read", input: { file_path: "x.ts" } },
          ],
        },
      },
    ]);
  });

  it("forwards only tool_result blocks from user messages", () => {
    expect(
      mapClaudeMessage({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tc-1", content: [{ type: "text", text: "ok" }], is_error: false },
          ],
        },
      })
    ).toEqual([
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tc-1", content: [{ type: "text", text: "ok" }], is_error: false },
          ],
        },
      },
    ]);
  });

  it("maps a success result with usage and cost", () => {
    expect(
      mapClaudeMessage({
        type: "result",
        subtype: "success",
        result: "final",
        total_cost_usd: 0.42,
        num_turns: 3,
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    ).toEqual([
      {
        type: "result",
        result: "final",
        is_error: false,
        total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
    ]);
  });

  it("maps an error result as is_error with a null result", () => {
    const got = mapClaudeMessage({
      type: "result",
      subtype: "error_max_turns",
      total_cost_usd: 0.1,
      usage: { input_tokens: 5, output_tokens: 0 },
    });
    expect(got[0]).toMatchObject({ type: "result", is_error: true, result: null, total_cost_usd: 0.1 });
  });

  it("maps streaming text/thinking deltas", () => {
    expect(
      mapClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ab" } } })
    ).toEqual([{ type: "stream_text", text: "ab" }]);
    expect(
      mapClaudeMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } })
    ).toEqual([{ type: "stream_thinking", text: "hmm" }]);
  });

  it("maps unknown messages to nothing", () => {
    expect(mapClaudeMessage({ type: "task_progress" })).toEqual([]);
  });
});
