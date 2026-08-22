import React from "react";
import { Box, Text } from "ink";
import type { PaletteItem } from "../model/palette.js";
import { C, useGlyphs } from "../theme.js";
import { fit, layoutPalette, layoutPaletteRow } from "./layout.js";

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
  // Border, padding and the three columns of a row all come out of one
  // arithmetic in layout.ts, so the overlay cannot be wider than the pane it
  // floats over — which at 80 columns it very nearly is.
  const box = layoutPalette(width);
  const empty = query.trim() ? `no match for "${query.trim()}"` : "nothing to jump to";
  return (
    <Box flexDirection="column" borderStyle={g.border} borderColor={C.hair} width={box.width} paddingX={1}>
      <Box>
        <Text color={C.muted}>jump to </Text>
        <Text color={C.fg}>{fit(query, box.queryW, g.ellipsis)}</Text>
        <Text color={C.muted}>{g.bar}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={C.muted}>{fit(empty, box.inner, g.ellipsis)}</Text>}
        {items.map((p, i) => {
          const c = layoutPaletteRow(p, box, g);
          return (
            <Text key={`${p.kind}:${p.id}`} inverse={i === cursor}>
              <Text color={C.muted}>{c.kind}</Text>
              <Text color={p.kind === "run" ? C.running : C.fg}>{c.id}</Text>
              <Text color={C.fg}>{c.label}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={C.muted}>{fit(`${g.move} move · ${g.enter} open · esc close`, box.inner, g.ellipsis)}</Text>
      </Box>
    </Box>
  );
}
