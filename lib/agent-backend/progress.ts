import { createHash } from "node:crypto";

/** Observe SDK progress separately from transcript mapping. Do not copy tool
 * arguments, output, or model text into watchdog diagnostics. Keep only a
 * bounded fingerprint cache so repeated snapshots cannot conceal a stall. */
export function createBackendProgressReporter(report: ((activity: string) => void) | undefined) {
  const seen = new Map<string, string>();
  function changed(key: string, value: unknown, label: string) {
    if (!report) return;
    const hash = createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");
    if (seen.get(key) === hash) return;
    seen.delete(key);
    seen.set(key, hash);
    if (seen.size > 512) seen.delete(seen.keys().next().value!);
    report(label.slice(0, 200));
  }
  function delta(value: unknown, label: string) {
    if (typeof value === "string" && value.length > 0) report?.(label);
  }
  return {
    codex(ev: any) {
      if (!report || !["item.started", "item.updated", "item.completed"].includes(ev?.type)) return;
      const item = ev.item;
      if (!item || typeof item.id !== "string" || item.type === "error") return;
      // Only content-bearing fields and lifecycle transitions count. In
      // particular, a future elapsed-time/heartbeat field must not reset us.
      changed(`codex:${item.id}`, {
        phase: ev.type, type: item.type, status: item.status, text: item.text,
        output: item.aggregated_output, changes: item.changes, items: item.items,
        result: item.result, error: item.error, query: item.query,
      }, `Codex ${item.type} (${item.id}): ${ev.type.slice(5)}`);
    },
    claude(msg: any) {
      if (!report) return;
      if (msg?.type === "stream_event" && msg.event?.type === "content_block_delta") {
        const d = msg.event.delta;
        delta(d?.text ?? d?.thinking ?? d?.partial_json, "Claude model output");
      } else if (msg?.type === "assistant" || msg?.type === "user") {
        const content = msg.message?.content;
        if (!Array.isArray(content) || content.length === 0) return;
        const tool = content.find((b: any) => b.type === "tool_use" || b.type === "tool_result");
        changed(`claude:${msg.uuid ?? msg.message?.id ?? msg.type}`, content,
          tool ? `Claude tool ${tool.name ?? tool.tool_use_id ?? "result"}` : "Claude assistant message");
      }
      // tool_progress contains elapsed time, not command output. Ignore it,
      // plus reconnect/status messages: a living process may still be stuck.
    },
    pi(ev: any) {
      if (!report) return;
      if (ev?.type === "message_update") {
        const d = ev.assistantMessageEvent;
        if (["text_delta", "thinking_delta", "toolcall_delta"].includes(d?.type)) delta(d.delta, "Pi model output");
      } else if (ev?.type === "message_end" && ev.message?.role === "assistant") {
        changed(`pi-message:${ev.message.timestamp ?? "current"}`, ev.message.content, "Pi assistant message");
      } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(ev?.type)) {
        changed(`pi-tool:${ev.toolCallId}`, {
          phase: ev.type, content: (ev.partialResult ?? ev.result)?.content,
        }, `Pi tool ${ev.toolName ?? ev.toolCallId ?? "unknown"}: ${ev.type.slice(15)}`);
      }
    },
  };
}
