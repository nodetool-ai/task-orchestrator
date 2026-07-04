// lib/tool-grouping.ts
//
// Fold consecutive tool-only messages into one collapsible "N tools called"
// group so a long run of tool calls doesn't flood the transcript. Agents emit
// one tool per message, so the grouping happens at the message-list level (not
// within a message). Generic over the view's message shape — it only needs the
// `content` blocks' `type`.

export type ToolSegment<T> =
  | { kind: "message"; message: T }
  | { kind: "tools"; messages: T[]; toolCount: number };

const isToolInteractionOnly = (content: { type?: string }[]): boolean =>
  content.length > 0 && content.every((b) => b.type === "tool_use" || b.type === "tool_result");

const countTools = (content: { type?: string }[]): number =>
  content.filter((b) => b.type === "tool_use").length;

/**
 * Collapse consecutive tool interaction messages into one group. SDK streams
 * usually persist a tool call as an assistant `tool_use` row followed by a user
 * `tool_result` row; treating both as one interaction prevents alternating
 * "Tool X" / "tool result" rows from flooding the transcript.
 *
 * A lone tool call still stays a normal message (no "1 tool called" noise), but
 * a call+result pair is grouped so the result does not break adjacent calls.
 */
export function segmentToolMessages<T extends { content: { type?: string }[] }>(
  messages: T[]
): ToolSegment<T>[] {
  const out: ToolSegment<T>[] = [];
  let group: T[] = [];
  const flush = () => {
    const toolCount = group.reduce((n, m) => n + countTools(m.content), 0);
    if (toolCount >= 2 || (toolCount === 1 && group.length >= 2)) {
      out.push({ kind: "tools", messages: group, toolCount });
    } else {
      for (const m of group) out.push({ kind: "message", message: m });
    }
    group = [];
  };
  for (const m of messages) {
    if (isToolInteractionOnly(m.content)) {
      group.push(m);
    } else {
      flush();
      out.push({ kind: "message", message: m });
    }
  }
  flush();
  return out;
}
