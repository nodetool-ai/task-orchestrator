import React from "react";
import { Box, Text } from "ink";
import type { PaletteItem } from "../model/palette.js";
import { C, padEnd, useGlyphs } from "../theme.js";
import { fit } from "./layout.js";

// ⌘K-style jump. Drawn as an overlay box in the middle of the screen. The
// matching lives in model/palette.ts — this only draws what it was handed.
export function Palette({
  items,
  query,
  cursor,
  width,
}: {
  items: PaletteItem[];
  query: string;
  cursor: number;
  width: number;
}) {
  const g = useGlyphs();
  const w = Math.max(24, Math.min(72, width - 4));
  // The round border and paddingX each take a column on both sides.
  const inner = w - 4;
  const labelW = Math.max(8, inner - 15);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.hair} width={w} paddingX={1}>
      <Box>
        <Text color={C.muted}>jump to </Text>
        <Text>{fit(query, Math.max(4, inner - 9), g.ellipsis)}</Text>
        <Text color={C.muted}>{g.bar}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={C.muted}>{query.trim() ? `no match for "${fit(query.trim(), 30, g.ellipsis)}"` : "nothing to jump to"}</Text>}
        {items.map((p, i) => (
          <Text key={`${p.kind}:${p.id}`} inverse={i === cursor}>
            <Text color={C.muted}>{padEnd(p.kind, 5)}</Text>
            <Text color={p.kind === "run" ? C.running : C.fg}>{padEnd(p.id, 10)}</Text>
            <Text>{padEnd(fit(p.label, labelW, g.ellipsis), labelW)}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={C.muted}>{`${g.move} move · ${g.enter} open · esc close`}</Text>
      </Box>
    </Box>
  );
}
