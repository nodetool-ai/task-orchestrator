import type { BackendDiagnostics } from "./types";

/** Observe SDK progress separately from transcript mapping. Do not copy tool
 * arguments, output, or model text into watchdog diagnostics. Keep only a
 * bounded fingerprint cache so repeated snapshots cannot conceal a stall. */
export function createBackendProgressReporter(
  report: ((activity: string) => void) | undefined,
  diagnostics?: BackendDiagnostics,
  invocationId?: string,
) {
  const seen = new Map<string, string>();
  const toolStarts = new Map<string, number>();
  const toolItem = (type: unknown): boolean =>
    typeof type === "string" && ["command_execution", "file_change", "web_search"].includes(type);
  const emit = (event: string, attributes: Record<string, unknown>) => {
    try { diagnostics?.emit(event, attributes, invocationId ? { invocationId } : undefined); } catch { /* best effort */ }
  };
  const contentShape = (content: unknown) => Array.isArray(content)
    ? content.slice(0, 8).map((block: any) => ({
        type: block?.type,
        id: block?.id ?? block?.tool_use_id,
        name: block?.name,
        textLength: typeof block?.text === "string" ? block.text.length : undefined,
        contentLength: typeof block?.content === "string"
          ? block.content.length
          : Array.isArray(block?.content) ? block.content.length : undefined,
      }))
    : [];
  function changed(key: string, value: unknown, label: string, itemId?: string) {
    if (!report && !diagnostics) return;
    // Values supplied here are bounded lifecycle/length summaries. Never hash
    // or rescan cumulative SDK output just to detect progress.
    const signature = JSON.stringify(value) ?? "";
    if (seen.get(key) === signature) return;
    seen.delete(key);
    seen.set(key, signature);
    if (seen.size > 512) seen.delete(seen.keys().next().value!);
    const activity = label.slice(0, 200);
    try { diagnostics?.meaningfulProgress?.(activity, itemId); } catch { /* best effort */ }
    report?.(activity);
  }
  function delta(value: unknown, label: string, itemId?: string) {
    if (typeof value === "string" && value.length > 0) {
      try { diagnostics?.meaningfulProgress?.(label, itemId); } catch { /* best effort */ }
      report?.(label);
    }
  }
  return {
    codex(ev: any) {
      try { diagnostics?.rawSdkEvent?.(typeof ev?.type === "string" ? ev.type : "unknown"); } catch { /* best effort */ }
      if ((!report && !diagnostics) || !["item.started", "item.updated", "item.completed"].includes(ev?.type)) return;
      const item = ev.item;
      if (!item || typeof item.id !== "string" || item.type === "error") return;
      if (toolItem(item.type) && ev.type === "item.started" && !toolStarts.has(item.id)) {
        toolStarts.set(item.id, typeof performance !== "undefined" ? performance.now() : Date.now());
        emit("tool.started", { "tool.name": item.type, "tool.item_id": item.id });
      } else if (toolItem(item.type) && ev.type === "item.completed" && toolStarts.has(item.id)) {
        const startedAt = toolStarts.get(item.id)!;
        toolStarts.delete(item.id);
        emit("tool.finished", {
          "tool.name": item.type,
          "tool.item_id": item.id,
          "tool.outcome": item.status === "failed" || item.error ? "error" : "completed",
          "tool.duration_ms": Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
        });
      }
      // Only content-bearing fields and lifecycle transitions count. In
      // particular, a future elapsed-time/heartbeat field must not reset us.
      changed(`codex:${item.id}`, {
        phase: ev.type,
        type: item.type,
        status: item.status,
        textLength: typeof item.text === "string" ? item.text.length : undefined,
        outputLength: typeof item.aggregated_output === "string" ? item.aggregated_output.length : undefined,
        changesCount: Array.isArray(item.changes) ? item.changes.length : undefined,
        itemsCount: Array.isArray(item.items) ? item.items.length : undefined,
        hasResult: item.result != null,
        hasError: item.error != null,
      }, `Codex ${item.type} (${item.id}): ${ev.type.slice(5)}`, item.id);
    },
    claude(msg: any) {
      try {
        const type = typeof msg?.event?.type === "string" ? `${msg.type}:${msg.event.type}` : (typeof msg?.type === "string" ? msg.type : "unknown");
        diagnostics?.rawSdkEvent?.(type);
      } catch { /* best effort */ }
      if (!report && !diagnostics) return;
      if (msg?.type === "stream_event" && msg.event?.type === "content_block_delta") {
        const d = msg.event.delta;
        delta(d?.text ?? d?.thinking ?? d?.partial_json, "Claude model output", msg.uuid ?? msg.message?.id);
      } else if (msg?.type === "assistant" || msg?.type === "user") {
        const content = msg.message?.content;
        if (!Array.isArray(content) || content.length === 0) return;
        const tool = content.find((b: any) => b.type === "tool_use" || b.type === "tool_result");
        if (tool?.type === "tool_use" && typeof tool.id === "string" && typeof tool.name === "string" && !tool.name.startsWith("mcp__")) {
          toolStarts.set(tool.id, typeof performance !== "undefined" ? performance.now() : Date.now());
          emit("tool.started", { "tool.name": tool.name, "tool.item_id": tool.id });
        } else if (tool?.type === "tool_result" && typeof tool.tool_use_id === "string") {
          const startedAt = toolStarts.get(tool.tool_use_id);
          if (startedAt !== undefined) {
            toolStarts.delete(tool.tool_use_id);
            emit("tool.finished", {
              "tool.name": typeof tool.name === "string" ? tool.name : "native",
              "tool.item_id": tool.tool_use_id,
              "tool.outcome": tool.is_error ? "error" : "completed",
              "tool.duration_ms": Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
            });
          }
        }
        changed(`claude:${msg.uuid ?? msg.message?.id ?? msg.type}`, contentShape(content),
          tool ? `Claude tool ${tool.name ?? tool.tool_use_id ?? "result"}` : "Claude assistant message",
          msg.uuid ?? msg.message?.id);
      }
      // tool_progress contains elapsed time, not command output. Ignore it,
      // plus reconnect/status messages: a living process may still be stuck.
    },
    pi(ev: any) {
      try { diagnostics?.rawSdkEvent?.(typeof ev?.type === "string" ? ev.type : "unknown"); } catch { /* best effort */ }
      if (!report && !diagnostics) return;
      if (ev?.type === "message_update") {
        const d = ev.assistantMessageEvent;
        if (["text_delta", "thinking_delta", "toolcall_delta"].includes(d?.type)) delta(d.delta, "Pi model output", ev.toolCallId);
      } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
        changed(`pi-message:${ev.message.timestamp ?? "current"}`, contentShape(ev.message.content), "Pi assistant message", ev.message.id);
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(ev?.type)) {
        if (ev.type === "tool_execution_start" && typeof ev.toolCallId === "string" && !toolStarts.has(ev.toolCallId)) {
          toolStarts.set(ev.toolCallId, typeof performance !== "undefined" ? performance.now() : Date.now());
          emit("tool.started", { "tool.name": String(ev.toolName ?? "native"), "tool.item_id": ev.toolCallId });
        } else if (ev.type === "tool_execution_end" && typeof ev.toolCallId === "string" && toolStarts.has(ev.toolCallId)) {
          const startedAt = toolStarts.get(ev.toolCallId)!;
          toolStarts.delete(ev.toolCallId);
          emit("tool.finished", {
            "tool.name": String(ev.toolName ?? "native"),
            "tool.item_id": ev.toolCallId,
            "tool.outcome": ev.isError || ev.result?.isError ? "error" : "completed",
            "tool.duration_ms": Math.max(0, (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
          });
        }
        changed(`pi-tool:${ev.toolCallId}`, {
          phase: ev.type,
          contentShape: contentShape((ev.partialResult ?? ev.result)?.content),
        }, `Pi tool ${ev.toolName ?? ev.toolCallId ?? "unknown"}: ${ev.type.slice(15)}`, ev.toolCallId);
      }
    },
  };
}
