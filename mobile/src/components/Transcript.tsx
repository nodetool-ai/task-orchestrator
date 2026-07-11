import React, { useState } from "react";
import { Image, Text, View } from "react-native";

import { Mono, Press } from "./primitives";
import { Icon } from "./Icon";
import { MiniMarkdown } from "./MiniMarkdown";
import { useTheme } from "@/theme";
import type { MessageRow } from "@/lib/types";

// A single SDK content block. Mirrors lib/sdk-message.ts SdkContentBlock.
interface Block {
  type?: string;
  id?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  data?: string;
  mimeType?: string;
}

interface ToolInteraction {
  call?: Block;
  result?: Block;
}

type Segment =
  | { kind: "tools"; key: string; tools: ToolInteraction[] }
  | { kind: "msg"; key: string; role: MessageRow["role"]; blocks: Block[]; createdAt: string };

function isToolBlock(b: Block): boolean {
  return b.type === "tool_use" || b.type === "tool_result";
}

// Split the transcript into render segments: consecutive tool_use/tool_result
// blocks (even across adjacent messages) coalesce into one tool group; text and
// image blocks become message segments. Mirrors web run-view segmentTranscript.
function segment(messages: MessageRow[]): Segment[] {
  const segs: Segment[] = [];
  let toolBuf: Block[] = [];
  let toolKey = "";
  const flushTools = () => {
    if (!toolBuf.length) return;
    // Suffix with segs.length (mirrors web segmentTranscript): one message can
    // flush two tool groups (tool_use, text, tool_use), and both would
    // otherwise share the message-id key — duplicate sibling keys make React
    // mis-reconcile the groups.
    segs.push({ kind: "tools", key: `t${toolKey}-${segs.length}`, tools: pairTools(toolBuf) });
    toolBuf = [];
  };
  for (const m of messages) {
    const blocks = (Array.isArray(m.content) ? m.content : []) as Block[];
    let msgBuf: Block[] = [];
    const flushMsg = () => {
      if (!msgBuf.length) return;
      segs.push({ kind: "msg", key: `m${m.id}-${segs.length}`, role: m.role, blocks: msgBuf, createdAt: m.createdAt });
      msgBuf = [];
    };
    for (const b of blocks) {
      if (isToolBlock(b)) {
        flushMsg();
        toolBuf.push(b);
        toolKey = `${m.id}`;
      } else {
        flushTools();
        msgBuf.push(b);
      }
    }
    flushMsg();
  }
  flushTools();
  return segs;
}

// Pair each tool_use with its tool_result by tool_use_id (fallback: order).
function pairTools(blocks: Block[]): ToolInteraction[] {
  const interactions: ToolInteraction[] = [];
  const byId = new Map<string, ToolInteraction>();
  for (const b of blocks) {
    if (b.type === "tool_use") {
      const it: ToolInteraction = { call: b };
      interactions.push(it);
      if (b.id) byId.set(b.id, it);
    } else if (b.type === "tool_result") {
      const target = (b.tool_use_id && byId.get(b.tool_use_id)) || interactions.find((i) => i.call && !i.result);
      if (target) target.result = b;
      else interactions.push({ result: b });
    }
  }
  return interactions;
}

function humanizeTool(name?: string): string {
  if (!name) return "tool";
  return name
    .replace(/^mcp__/, "")
    .replace(/__/g, " · ")
    .replace(/_/g, " ")
    .trim();
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : b && typeof b === "object" && "text" in b ? String((b as Block).text ?? "") : ""))
      .join("\n")
      .trim();
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function Transcript({ messages, emptyLabel = "No messages yet." }: { messages: MessageRow[]; emptyLabel?: string }) {
  const { c } = useTheme();
  const segs = segment([...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  const visible = segs.filter((s) => (s.kind === "tools" ? s.tools.length : hasVisible(s.blocks)));

  if (!visible.length) {
    return <Text style={{ color: c.muted2, fontSize: 12, paddingVertical: 8 }}>{emptyLabel}</Text>;
  }
  return (
    <View style={{ gap: 12 }}>
      {visible.map((s) =>
        s.kind === "tools" ? (
          <ToolGroup key={s.key} tools={s.tools} />
        ) : s.role === "user" ? (
          <UserBubble key={s.key} blocks={s.blocks} />
        ) : s.role === "system" ? (
          <SystemRow key={s.key} blocks={s.blocks} />
        ) : (
          <AgentBlocks key={s.key} role={s.role} blocks={s.blocks} />
        )
      )}
    </View>
  );
}

function hasVisible(blocks: Block[]): boolean {
  return blocks.some(
    (b) =>
      b.type === "image" ||
      b.type === "tool_result" ||
      (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0)
  );
}

function UserBubble({ blocks }: { blocks: Block[] }) {
  const { c } = useTheme();
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (!text) return null;
  return (
    <View style={{ alignItems: "flex-end" }}>
      <View
        style={{
          maxWidth: "85%",
          backgroundColor: c.fg,
          paddingVertical: 9,
          paddingHorizontal: 13,
          borderRadius: 16,
          borderBottomRightRadius: 5,
        }}
      >
        <Text style={{ color: c.bg, fontSize: 13.5, lineHeight: 19 }}>{text}</Text>
      </View>
    </View>
  );
}

function AgentBlocks({ role, blocks }: { role: MessageRow["role"]; blocks: Block[] }) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {role === "tool" ? <ToolResultBlock content={blocks.map((b) => b.content)} /> : null}
      {blocks.map((b, i) => {
        if (b.type === "text" && b.text?.trim()) {
          return <MiniMarkdown key={i} body={b.text} size={13} />;
        }
        if (b.type === "image" && b.data) {
          return (
            <Image
              key={i}
              source={{ uri: `data:${b.mimeType || "image/png"};base64,${b.data}` }}
              style={{ width: "100%", height: 200, borderRadius: 10, borderWidth: 1, borderColor: c.hairline }}
              resizeMode="contain"
            />
          );
        }
        return null;
      })}
    </View>
  );
}

function ToolResultBlock({ content }: { content: unknown[] }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const text = content.map(blockText).filter(Boolean).join("\n---\n").slice(0, 4000);
  if (!text) return null;
  return (
    <View>
      <Press onPress={() => setOpen((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={open ? "chev-d" : "chev-r"} size={12} color={c.muted2} />
        <Mono style={{ fontSize: 10.5, color: c.muted2 }}>tool result</Mono>
      </Press>
      {open ? (
        <View style={{ marginTop: 5, padding: 9, backgroundColor: c.raised, borderRadius: 8, borderWidth: 1, borderColor: c.hairline }}>
          <Mono style={{ fontSize: 10.5, color: c.muted, lineHeight: 15 }}>{text}</Mono>
        </View>
      ) : null}
    </View>
  );
}

function ToolGroup({ tools }: { tools: ToolInteraction[] }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const names = tools.map((t) => humanizeTool(t.call?.name)).filter(Boolean);
  const summary =
    tools.length === 1
      ? `Ran ${names[0] || "tool"}`
      : `Ran ${tools.length} tool calls: ${names.slice(0, 2).join(", ")}${names.length > 2 ? `, +${names.length - 2} more` : ""}`;
  return (
    <View style={{ borderWidth: 1, borderColor: c.hairline, borderRadius: 11, backgroundColor: c.surface }}>
      <Press onPress={() => setOpen((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 11 }}>
        <Icon name={open ? "chev-d" : "chev-r"} size={13} color={c.muted} />
        <Icon name="term" size={12} color={c.sProgress} />
        <Text style={{ flex: 1, fontSize: 12.5, color: c.fg }} numberOfLines={open ? undefined : 1}>
          {summary}
        </Text>
      </Press>
      {open ? (
        <View style={{ paddingHorizontal: 11, paddingBottom: 11, gap: 10 }}>
          {tools.map((t, i) => (
            <ToolInteractionRow key={i} interaction={t} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolInteractionRow({ interaction }: { interaction: ToolInteraction }) {
  const { c } = useTheme();
  const input = interaction.call?.input;
  const inputText = input == null ? "" : typeof input === "string" ? input : safeJson(input);
  const resultText = interaction.result ? blockText(interaction.result.content).slice(0, 4000) : "";
  return (
    <View style={{ gap: 5, borderTopWidth: 1, borderTopColor: c.hairline, paddingTop: 9 }}>
      <Mono style={{ fontSize: 11, color: c.sProgress }}>{humanizeTool(interaction.call?.name)}</Mono>
      {inputText ? (
        <View style={{ padding: 8, backgroundColor: c.raised, borderRadius: 7 }}>
          <Mono style={{ fontSize: 10, color: c.muted, lineHeight: 15 }}>{inputText.slice(0, 2000)}</Mono>
        </View>
      ) : null}
      {resultText ? (
        <View style={{ padding: 8, backgroundColor: c.raised, borderRadius: 7 }}>
          <Mono style={{ fontSize: 10, color: c.muted2, lineHeight: 15 }}>{resultText}</Mono>
        </View>
      ) : null}
    </View>
  );
}

function SystemRow({ blocks }: { blocks: Block[] }) {
  const { c } = useTheme();
  const first = blocks[0] || {};
  const kind = typeof first.type === "string" && first.type !== "text" ? first.type : null;
  const text = blockText(blocks.map((b) => (b.type === "text" ? b.text : b)).filter(Boolean)) || (kind ?? "system event");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 3 }}>
      <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: c.muted2 }} />
      <Mono style={{ fontSize: 10.5, color: c.muted2, flex: 1 }} numberOfLines={2}>
        {kind ? `${kind.replace(/_/g, " ")}: ` : ""}
        {text.slice(0, 200)}
      </Mono>
    </View>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
