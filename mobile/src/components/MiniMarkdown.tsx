import React from "react";
import { Text, View } from "react-native";

import { Mono } from "./primitives";
import { useTheme } from "@/theme";

// Lightweight markdown for plan/task bodies — headings, bullets, numbered
// lists and paragraphs. Inline ** ** bold and `code` are stripped/styled.
export function MiniMarkdown({ body }: { body: string }) {
  const { c } = useTheme();
  if (!body?.trim()) return <Text style={{ color: c.muted2, fontSize: 13 }}>No description.</Text>;
  const lines = body.replace(/\r/g, "").split("\n");
  const out: React.ReactNode[] = [];
  let n = 0;

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim()) {
      out.push(<View key={`s${i}`} style={{ height: 8 }} />);
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      out.push(
        <Text key={i} style={{ fontSize: 14, fontWeight: "700", color: c.fg, marginTop: n ? 10 : 0, marginBottom: 4 }}>
          {inline(heading[2])}
        </Text>
      );
      n++;
      return;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      out.push(
        <View key={i} style={{ flexDirection: "row", gap: 9, marginBottom: 7 }}>
          <Text style={{ color: c.muted2, fontSize: 13, lineHeight: 20 }}>•</Text>
          <Text style={{ flex: 1, fontSize: 13, lineHeight: 20, color: c.fg }}>{inline(bullet[1])}</Text>
        </View>
      );
      n++;
      return;
    }
    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (numbered) {
      out.push(
        <View key={i} style={{ flexDirection: "row", gap: 10, marginBottom: 7 }}>
          <Mono style={{ fontSize: 12, color: c.muted2, lineHeight: 20, minWidth: 16 }}>{numbered[1]}</Mono>
          <Text style={{ flex: 1, fontSize: 13, lineHeight: 20, color: c.fg }}>{inline(numbered[2])}</Text>
        </View>
      );
      n++;
      return;
    }
    out.push(
      <Text key={i} style={{ fontSize: 13.5, lineHeight: 21, color: c.fg, marginBottom: 6 }}>
        {inline(line)}
      </Text>
    );
    n++;
  });

  return <View>{out}</View>;
}

function inline(s: string): string {
  return s.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1");
}
