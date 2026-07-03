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

const isToolOnly = (content: { type?: string }[]): boolean =>
  content.length > 0 && content.every((b) => b.type === "tool_use");

const countTools = (content: { type?: string }[]): number =>
  content.filter((b) => b.type === "tool_use").length;

/**
 * Collapse runs of ≥2 consecutive tool-only messages into a single group; a lone
 * tool message stays a normal message (no "1 tool called" noise). Non-tool
 * messages (text, user, system) pass through and break a group.
 */
export function segmentToolMessages<T extends { content: { type?: string }[] }>(
  messages: T[]
): ToolSegment<T>[] {
  const out: ToolSegment<T>[] = [];
  let group: T[] = [];
  const flush = () => {
    if (group.length >= 2) {
      out.push({
        kind: "tools",
        messages: group,
        toolCount: group.reduce((n, m) => n + countTools(m.content), 0),
      });
    } else {
      for (const m of group) out.push({ kind: "message", message: m });
    }
    group = [];
  };
  for (const m of messages) {
    if (isToolOnly(m.content)) {
      group.push(m);
    } else {
      flush();
      out.push({ kind: "message", message: m });
    }
  }
  flush();
  return out;
}
