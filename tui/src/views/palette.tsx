import React from "react";
import { Box, Text } from "ink";
import { palette } from "../data.js";
import { C, padEnd } from "../theme.js";

export function filterPalette(q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return palette.slice(0, 9);
  return palette.filter((p) => (p.id + " " + p.label).toLowerCase().includes(needle)).slice(0, 9);
}

// ⌘K-style jump. Drawn as an overlay box in the middle of the screen.
export function Palette({ query, cursor, width }: { query: string; cursor: number; width: number }) {
  const w = Math.min(72, width - 4);
  const items = filterPalette(query);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.hair} width={w} paddingX={1}>
      <Box>
        <Text color={C.muted}>jump to </Text>
        <Text>{query}</Text>
        <Text color={C.muted}>▏</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={C.muted}>no match</Text>}
        {items.map((p, i) => (
          <Text key={p.id} inverse={i === cursor}>
            <Text color={C.muted}>{padEnd(p.kind, 5)}</Text>
            <Text color={p.kind === "run" ? C.running : C.fg}>{padEnd(p.id, 10)}</Text>
            <Text>{p.label.length > w - 20 ? p.label.slice(0, w - 21) + "…" : p.label}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={C.muted}>↑↓ move · ↵ open · esc close</Text>
      </Box>
    </Box>
  );
}
