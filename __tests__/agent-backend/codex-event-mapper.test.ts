import { describe, expect, it } from "vitest";
import { mapCodexEvent, truncateOutput } from "../../lib/agent-backend/codex-event-mapper";

describe("mapCodexEvent", () => {
  it("maps thread.started to a system/init envelope (untagged thread id)", () => {
    expect(mapCodexEvent({ type: "thread.started", thread_id: "th_1" })).toEqual([
      { type: "system", subtype: "init", session_id: "th_1" },
    ]);
  });

  it("ignores the in-progress item lifecycle (only item.completed is mapped)", () => {
    const item = { id: "i1", type: "agent_message", text: "partial" };
    expect(mapCodexEvent({ type: "turn.started" })).toEqual([]);
    expect(mapCodexEvent({ type: "item.started", item })).toEqual([]);
    expect(mapCodexEvent({ type: "item.updated", item })).toEqual([]);
  });

  it("maps an agent_message to an assistant text envelope", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } })).toEqual([
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
    ]);
  });

  it("maps reasoning to a stream_thinking envelope (live only, never persisted)", () => {
    expect(
      mapCodexEvent({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "hmm" } })
    ).toEqual([{ type: "stream_thinking", text: "hmm" }]);
  });

  it("maps a command execution to a canonical Bash tool_use + its tool_result", () => {
    const out = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "2 passing",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(out).toEqual([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "cmd-1", name: "Bash", input: { command: "npm test" } }] },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "cmd-1",
              content: [{ type: "text", text: "exit 0\n2 passing" }],
              is_error: false,
            },
          ],
        },
      },
    ]);
  });

  it("flags a non-zero exit as a tool error even when the item reports completed", () => {
    const [, result] = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "false",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
    });
    expect((result as any).message.content[0].is_error).toBe(true);
  });

  it("maps a file_change to an Edit tool_use listing every path", () => {
    const [use, result] = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "fc-1",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "a.ts", kind: "update" },
          { path: "b.ts", kind: "add" },
        ],
      },
    });
    expect((use as any).message.content[0]).toMatchObject({ name: "Edit", input: { path: "a.ts" } });
    expect((result as any).message.content[0].content[0].text).toBe("update: a.ts\nadd: b.ts");
  });

  it("names an MCP call the way every other harness does, so the UI humanizes it", () => {
    const [use, result] = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "task_orch",
        tool: "task_orch__create_task",
        arguments: { title: "x" },
        status: "completed",
        result: { content: [{ type: "text", text: "created" }] },
      },
    });
    expect((use as any).message.content[0]).toMatchObject({
      name: "mcp__task_orch__task_orch__create_task",
      input: { title: "x" },
    });
    expect((result as any).message.content[0]).toMatchObject({ is_error: false });
  });

  it("surfaces an MCP failure as an errored tool_result", () => {
    const [, result] = mapCodexEvent({
      type: "item.completed",
      item: {
        id: "mcp-2",
        type: "mcp_tool_call",
        server: "task_orch",
        tool: "task_orch__create_task",
        arguments: {},
        status: "failed",
        error: { message: "denied" },
      },
    });
    expect((result as any).message.content[0]).toMatchObject({
      is_error: true,
      content: [{ type: "text", text: "denied" }],
    });
  });

  it("closes the pair for web_search and todo_list so neither renders as pending", () => {
    expect(mapCodexEvent({ type: "item.completed", item: { id: "w", type: "web_search", query: "q" } })).toHaveLength(2);
    const [use, result] = mapCodexEvent({
      type: "item.completed",
      item: { id: "t", type: "todo_list", items: [{ text: "a", completed: true }, { text: "b" }] },
    });
    expect((use as any).message.content[0].name).toBe("TodoWrite");
    expect((result as any).message.content[0].content[0].text).toBe("1/2 complete");
  });

  it("carries the last agent message onto the turn result, with tokens but no cost", () => {
    expect(
      mapCodexEvent(
        { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
        { lastAgentMessage: "all set" }
      )
    ).toEqual([
      {
        type: "result",
        result: "all set",
        is_error: false,
        // Codex reports tokens only — never claim a $0 turn.
        total_cost_usd: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    ]);
  });

  it("maps turn.failed and a stream error to errored results", () => {
    expect(mapCodexEvent({ type: "turn.failed", error: { message: "boom" } })).toEqual([
      { type: "result", result: "boom", is_error: true, total_cost_usd: null },
    ]);
    expect(mapCodexEvent({ type: "error", message: "stream died" })).toEqual([
      { type: "result", result: "stream died", is_error: true, total_cost_usd: null },
    ]);
  });

  it("ignores unknown events rather than throwing", () => {
    expect(mapCodexEvent({ type: "something.new" })).toEqual([]);
    expect(mapCodexEvent(undefined)).toEqual([]);
  });
});

describe("truncateOutput", () => {
  it("passes short output through untouched", () => {
    expect(truncateOutput("hello", 100)).toBe("hello");
  });

  it("keeps the head and the tail of a long command output", () => {
    const text = "A".repeat(50) + "B".repeat(50);
    const out = truncateOutput(text, 20);
    expect(out.startsWith("A".repeat(12))).toBe(true);
    expect(out.endsWith("B".repeat(8))).toBe(true);
    expect(out).toContain("characters omitted");
  });
});
