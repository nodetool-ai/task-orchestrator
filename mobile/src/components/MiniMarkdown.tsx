import React from "react";
import { Text, View } from "react-native";

import { Mono } from "./primitives";
import { useTheme, mono } from "@/theme";

// Lightweight markdown for plan/task bodies and agent chat text — headings,
// bullets, numbered lists, fenced code blocks, paragraphs, plus inline **bold**,
// `code` and [links](url). Mirrors what the web renders with `marked`, scoped to
// the subset agents actually emit.
export function MiniMarkdown({ body, size = 13 }: { body: string; size?: number }) {
  const { c } = useTheme();
  if (!body?.trim()) return <Text style={{ color: c.muted2, fontSize: size }}>No description.</Text>;
  const lines = body.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let n = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Fenced code block ``` … ```
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      out.push(
        <View
          key={`c${i}`}
          style={{
            backgroundColor: c.raised,
            borderWidth: 1,
            borderColor: c.hairline,
            borderRadius: 9,
            padding: 10,
            marginVertical: 6,
          }}
        >
          <Mono style={{ fontSize: size - 2, color: c.fg, lineHeight: (size - 2) * 1.5 }}>{code.join("\n")}</Mono>
        </View>
      );
      n++;
      continue;
    }

    if (!line.trim()) {
      out.push(<View key={`s${i}`} style={{ height: 8 }} />);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(
        <Text key={i} style={{ fontSize: size + 1, fontWeight: "700", color: c.fg, marginTop: n ? 10 : 0, marginBottom: 4 }}>
          {inline(heading[2], c, size + 1)}
        </Text>
      );
      n++;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      out.push(
        <View key={i} style={{ flexDirection: "row", gap: 9, marginBottom: 7 }}>
          <Text style={{ color: c.muted2, fontSize: size, lineHeight: size * 1.55 }}>•</Text>
          <Text style={{ flex: 1, fontSize: size, lineHeight: size * 1.55, color: c.fg }}>{inline(bullet[1], c, size)}</Text>
        </View>
      );
      n++;
      continue;
    }
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      out.push(
        <View key={i} style={{ flexDirection: "row", gap: 10, marginBottom: 7 }}>
          <Mono style={{ fontSize: size - 1, color: c.muted2, lineHeight: size * 1.55, minWidth: 16 }}>{numbered[1]}</Mono>
          <Text style={{ flex: 1, fontSize: size, lineHeight: size * 1.55, color: c.fg }}>{inline(numbered[2], c, size)}</Text>
        </View>
      );
      n++;
      continue;
    }
    out.push(
      <Text key={i} style={{ fontSize: size + 0.5, lineHeight: (size + 0.5) * 1.55, color: c.fg, marginBottom: 6 }}>
        {inline(line, c, size)}
      </Text>
    );
    n++;
  }

  return <View>{out}</View>;
}

// Parse inline **bold**, `code` and [text](url) into styled Text spans.
function inline(s: string, c: ReturnType<typeof useTheme>["c"], size: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    if (m[1] != null) {
      nodes.push(
        <Text key={k++} style={{ fontWeight: "700" }}>
          {m[1]}
        </Text>
      );
    } else if (m[2] != null) {
      nodes.push(
        <Text key={k++} style={{ fontFamily: mono, fontSize: size - 1.5, color: c.sProgress }}>
          {m[2]}
        </Text>
      );
    } else if (m[3] != null) {
      nodes.push(
        <Text key={k++} style={{ color: c.sReview, textDecorationLine: "underline" }}>
          {m[3]}
        </Text>
      );
    }
    last = re.lastIndex;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes.length ? nodes : [s];
}
