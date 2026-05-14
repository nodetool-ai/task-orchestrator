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

  it("message_end with content emits an assistant envelope", () => {
    const got = mapPiEvent(
      { type: "message_end", message: { content: [{ type: "text", text: "hi" }] } },
      {}, sm("/x")
    );
    expect(got).toEqual([{
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }]);
  });

  it("message_end with empty content emits nothing", () => {
    expect(mapPiEvent(
      { type: "message_end", message: { content: [] } }, {}, sm("/x")
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

  it("agent_end emits a result envelope with last assistant text and tokens", () => {
    const got = mapPiEvent({
      type: "agent_end",
      messages: [
        { content: [{ type: "text", text: "first" }] },
        { content: [{ type: "text", text: "final" }] },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
    }, {}, sm("/x"));
    expect(got).toEqual([{
      type: "result",
      result: "final",
      is_error: false,
      total_cost_usd: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }]);
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
