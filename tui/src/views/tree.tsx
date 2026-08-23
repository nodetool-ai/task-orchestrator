import React from "react";
import { Box, Text } from "ink";
import type { Forest, TreeRow } from "../model/forest.js";
import { statusWord, threadStatusWord } from "../model/status.js";
import { C, StatusGlyph, age, statusColor, useGlyphs, usd } from "../theme.js";
import { layoutRow } from "./layout.js";

// One run, one line. The column arithmetic lives in layout.ts so the
// 80-column guarantee can be tested; this only paints the cells.
export function RunRow({
  row,
  width,
  now,
  forest,
  selected,
  compact,
  quiet,
}: {
  row: TreeRow;
  width: number;
  now: number;
  /** Supplies the subtree cost. Without it the row shows the run's own cost —
   *  right for a leaf, an undercount for a parent. */
  forest?: Forest;
  selected?: boolean;
  compact?: boolean;
  /** Drawn inside a conversation rather than on the floor: the routine states
   *  drop their word, because the glyph in front of the row already says it. */
  quiet?: boolean;
}) {
  const { run, prefix } = row;
  const g = useGlyphs();
  const cost = forest ? forest.subtreeCost(run.id) : run.cost;
  const cells = layoutRow({
    prefix,
    id: run.id,
    persona: run.persona,
    title: run.title,
    pr: run.pr,
    status: quiet === true ? threadStatusWord(run.status) : statusWord(run.status),
    age: age(run.startedAt, now),
    cost: usd(cost),
    width,
    compact,
    glyphs: g,
  });
  return (
    <Box>
      <Text inverse={selected}>
        <Text color={C.muted}>{cells.prefix}</Text>
        <StatusGlyph s={run.status} />{" "}
        <Text color={C.muted}>{cells.id}</Text>
        <Text color={run.parentId === null ? C.fg : C.muted} bold={run.parentId === null}>
          {cells.persona}
        </Text>
        <Text>{cells.title}</Text>
        <Text color={run.pr?.ci === "fail" ? C.blocked : C.muted}>{cells.pr}</Text>
        <Text color={statusColor(run.status)}>{cells.status}</Text>
        <Text color={C.muted}>{cells.age}</Text>
        <Text color={C.muted}>{cells.cost}</Text>
      </Text>
    </Box>
  );
}
