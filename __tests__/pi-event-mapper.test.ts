import { describe, expect, it } from "vitest";
import { mapPiEvent } from "../lib/pi-event-mapper";

const sm = (file: string | undefined) => ({ getSessionFile: () => file });

describe("mapPiEvent", () => {
  it("agent_start emits a system/init envelope with the session file path", () => {
    const got = mapPiEvent({ type: "agent_start" }, {}, sm("/p/.pi/sessions/abc.jsonl"));
    expect(got).toEqual([{
      type: "system", subtype: "init",
      session_id: "/p/.pi/sessions/abc.jsonl",
    }]);
  });

  it("agent_start with no session file emits nothing", () => {
    expect(mapPiEvent({ type: "agent_start" }, {}, sm(undefined))).toEqual([]);
  });

  it("message_end with assistant role emits an assistant envelope", () => {
    const got = mapPiEvent(
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
      {}, sm("/x")
    );
    expect(got).toEqual([{
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }]);
  });

  it("message_end normalizes pi `toolCall` blocks to SDK `tool_use` shape", () => {
    const got = mapPiEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "let me look" },
            { type: "toolCall", id: "tc-1", name: "Read", arguments: { path: "x.ts" } },
          ],
        },
      },
      {}, sm("/x")
    );
    expect(got).toEqual([{
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "tc-1", name: "Read", input: { path: "x.ts" } },
        ],
      },
    }]);
  });

  it("message_end with user role emits nothing (already persisted upstream)", () => {
    expect(mapPiEvent(
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      {}, sm("/x")
    )).toEqual([]);
  });

  it("message_end with empty assistant content emits nothing", () => {
    expect(mapPiEvent(
      { type: "message_end", message: { role: "assistant", content: [] } }, {}, sm("/x")
    )).toEqual([]);
  });

  it("tool_execution_end emits a user/tool_result envelope", () => {
    const got = mapPiEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "user",
      message: { content: [{
        type: "tool_result", tool_use_id: "tc-1",
        content: [{ type: "text", text: "ok" }], is_error: false,
      }] },
    }]);
  });

  it("agent_end sums per-AssistantMessage usage into the result envelope", () => {
    // pi never puts a `usage` field on agent_end; usage lives on each assistant
    // message as pi-ai's Usage shape ({input, output, cacheRead, cacheWrite,
    // cost:{total}}). We sum input/output tokens and cost.total across the
    // assistant messages. cacheRead/cacheWrite are deliberately NOT folded into
    // input_tokens (see sumAssistantUsage) — hence input_tokens is 140, not 145.
    const got = mapPiEvent({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.5 } },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "final" }],
          usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
        },
      ],
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "result",
      result: "final",
      is_error: false,
      total_cost_usd: 0.75,
      usage: { input_tokens: 140, output_tokens: 28 },
    }]);
  });

  it("agent_end reports null usage/cost when no assistant message carries usage", () => {
    // A run with no usage-bearing assistant message keeps the 'unknown' semantics
    // (usage undefined, cost null) instead of reporting a false 0.
    const got = mapPiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }],
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "result",
      result: "done",
      is_error: false,
      total_cost_usd: null,
      usage: undefined,
    }]);
  });

  it("agent_end marks is_error when the last assistant message aborted/errored", () => {
    for (const stopReason of ["error", "aborted"]) {
      const got = mapPiEvent({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "partial" }] },
          { role: "assistant", content: [{ type: "text", text: "" }], stopReason, errorMessage: "boom" },
        ],
      }, {}, sm("/x"));
      expect(got).toEqual([{
        type: "result",
        result: "boom",
        is_error: true,
        total_cost_usd: null,
        usage: undefined,
      }]);
    }
  });

  it("agent_end stays is_error=false for a clean stopReason", () => {
    const got = mapPiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "endTurn" }],
    }, {}, sm("/x"));
    expect(got[0]).toMatchObject({ type: "result", result: "done", is_error: false });
  });

  it("message_update text_delta emits a stream_text envelope", () => {
    const got = mapPiEvent(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ab" } },
      {}, sm("/x")
    );
    expect(got).toEqual([{ type: "stream_text", text: "ab" }]);
  });

  it("unknown event types map to nothing", () => {
    expect(mapPiEvent({ type: "queue_update" }, {}, sm("/x"))).toEqual([]);
  });
});
