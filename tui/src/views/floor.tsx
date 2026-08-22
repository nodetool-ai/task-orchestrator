import React from "react";
import { Box, Text } from "ink";
import { floorGroups, type Forest, type TreeRow } from "../model/forest.js";
import { C, Hair, Keys, useGlyphs, usd } from "../theme.js";
import { cursorWindow, layoutFloorHead } from "./layout.js";
import { RunRow } from "./tree.js";

type Entry = { kind: "row"; row: TreeRow; cursor: number } | { kind: "earlier" };

// The floor is the whole run forest as one tree: htop for agents. Top-level
// rows are the orchestrators you talk to; children are their workers.
export function Floor({
  forest,
  inboxCount,
  now,
  width,
  height,
  cursor,
}: {
  forest: Forest;
  inboxCount: number;
  now: number;
  width: number;
  height: number;
  cursor: number;
}) {
  const g = useGlyphs();
  const { live, rest } = floorGroups(forest, g);
  const today = forest.runs.reduce((s, r) => s + r.cost, 0);

  // One flat list so the viewport can scroll past the "earlier" divider
  // without the two groups drifting out of step with the cursor.
  const entries: Entry[] = live.map((row, i) => ({ kind: "row", row, cursor: i }));
  if (rest.length > 0) {
    entries.push({ kind: "earlier" });
    rest.forEach((row, i) => entries.push({ kind: "row", row, cursor: live.length + i }));
  }
  // header + hair + the blank line under it.
  const budget = Math.max(1, height - 3);
  const at = entries.findIndex((e) => e.kind === "row" && e.cursor === cursor);
  const { start, end } = cursorWindow(entries.length, budget, at < 0 ? 0 : at);

  // The headline and the hints share one line: at 80 columns the two only
  // just fit, and a wrapped header would push a transcript row off the
  // bottom, so both halves are measured and the hints give way first.
  const head = layoutFloorHead({
    live: forest.liveCount(),
    needsYou: inboxCount,
    today: usd(today),
    width,
    glyphs: g,
    keys: [
      [g.enter, "talk"],
      ["o", "open"],
      ["c", "cancel"],
      ["n", "new"],
      ["esc", "back"],
    ],
  });

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{head.parts[0]}</Text>
          <Text color={C.muted}>{head.parts[1]}</Text>
          <Text color={C.review}>{head.parts[2]}</Text>
          <Text color={C.muted}>{head.parts[3]}</Text>
        </Text>
        <Keys items={head.keys} />
      </Box>
      <Hair width={width} />
      <Box flexDirection="column" marginTop={1}>
        {entries.length === 0 && <Text color={C.muted}>No runs yet.</Text>}
        {entries.slice(start, end).map((e) =>
          e.kind === "earlier" ? (
            <Text key="earlier" color={C.muted}>
              earlier
            </Text>
          ) : (
            <RunRow
              key={e.row.run.id}
              row={e.row}
              forest={forest}
              width={width}
              now={now}
              selected={e.cursor === cursor}
            />
          )
        )}
      </Box>
    </Box>
  );
}
