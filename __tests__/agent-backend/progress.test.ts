import { describe, expect, it, vi } from "vitest";
import { createBackendProgressReporter } from "../../lib/agent-backend/progress";

describe("backend progress signals", () => {
  it("counts Codex tool starts, changed output, and completions; ignores repeated snapshots and errors", () => {
    const report = vi.fn();
    const progress = createBackendProgressReporter(report);
    const item = { id: "cmd1", type: "command_execution", command: "secret command", aggregated_output: "private output" };
    progress.codex({ type: "item.started", item });
    progress.codex({ type: "item.updated", item });
    progress.codex({ type: "item.updated", item: { ...item, elapsed_seconds: 999 } });
    expect(report).toHaveBeenCalledTimes(2);
    progress.codex({ type: "item.updated", item: { ...item, aggregated_output: "more output" } });
    progress.codex({ type: "item.completed", item });
    progress.codex({ type: "error", message: "Reconnecting..." });
    expect(report).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/secret command|private output|more output/);
  });

  it("includes Claude subagent output and model argument deltas, but excludes elapsed-time heartbeats", () => {
    const report = vi.fn();
    const progress = createBackendProgressReporter(report);
    progress.claude({ type: "assistant", parent_tool_use_id: "parent", message: { id: "m1", content: [{ type: "text", text: "working" }] } });
    progress.claude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } });
    progress.claude({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } } });
    progress.claude({ type: "tool_progress", tool_name: "Bash", elapsed_time_seconds: 2000 });
    progress.claude({ type: "system", subtype: "status", status: "compacting" });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("counts changed Pi tool output and model deltas, ignoring retries and repeated output", () => {
    const report = vi.fn();
    const progress = createBackendProgressReporter(report);
    const update = { type: "tool_execution_update", toolCallId: "cmd1", toolName: "bash", partialResult: { content: [{ type: "text", text: "compiling" }] } };
    progress.pi({ ...update, type: "tool_execution_start" });
    progress.pi(update);
    progress.pi(update);
    progress.pi({ ...update, partialResult: { content: [{ type: "text", text: "compiled" }] } });
    progress.pi({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
    progress.pi({ type: "auto_retry_start", attempt: 5 });
    expect(report).toHaveBeenCalledTimes(4);
  });

  it("records tool lifecycle by invocation and item id without copying payloads", () => {
    const emit = vi.fn();
    const diagnostics = { emit, rawSdkEvent: vi.fn(), meaningfulProgress: vi.fn() };
    const progress = createBackendProgressReporter(undefined, diagnostics, "inv-2");
    progress.codex({
      type: "item.started",
      item: { id: "reused-id", type: "command_execution", command: "do not log me" },
    });
    progress.codex({
      type: "item.completed",
      item: { id: "reused-id", type: "command_execution", aggregated_output: "secret output" },
    });
    progress.codex({ type: "item.started", item: { id: "mcp-id", type: "mcp_tool_call" } });
    progress.codex({ type: "item.completed", item: { id: "mcp-id", type: "mcp_tool_call" } });
    expect(emit).toHaveBeenNthCalledWith(1, "tool.started", expect.objectContaining({
      "tool.item_id": "reused-id",
    }), { invocationId: "inv-2" });
    expect(emit).toHaveBeenNthCalledWith(2, "tool.finished", expect.objectContaining({
      "tool.item_id": "reused-id",
      "tool.outcome": "completed",
    }), { invocationId: "inv-2" });
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/do not log me|secret output/);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
