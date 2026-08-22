import React from "react";
import { Box, Text } from "ink";
import { floorGroups, type Forest } from "../model/forest.js";
import { C, useGlyphs, usd } from "../theme.js";
import { clipSegments, fit, rosterRowWidth, rosterWindow } from "./layout.js";
import { RunRow } from "./tree.js";

// Right-hand rail: the live part of the forest, compact. Shown when the
// terminal is wide; ctrl+b toggles it. The current run is marked with ▸.
export function Roster({
  forest,
  inboxCount,
  now,
  width,
  height,
  current,
}: {
  forest: Forest;
  inboxCount: number;
  now: number;
  width: number;
  height: number;
  current: number | null;
}) {
  const g = useGlyphs();
  // Same grouping as the floor, so the rail and the floor agree on what is
  // still on the clock — including a finished parent with a working child.
  const rows = floorGroups(forest, g).live;
  const today = forest.runs.reduce((s, r) => s + r.cost, 0);
  // header + its blank line + the cost footer; one more line goes to the
  // "+n more" tally when the rail cannot show everything.
  const { shown, more } = rosterWindow(rows.length, height);
  const visible = rows.slice(0, shown);
  const rowW = rosterRowWidth(width);
  // The rail is 38 columns wide and its heading is short, but a four-figure
  // live count and a flagged inbox still have to fit inside it.
  const [live, count, flag] = clipSegments(
    ["LIVE", ` ${forest.liveCount()}`, inboxCount > 0 ? `  ${g.flag} ${inboxCount}` : ""],
    width - 1,
    g.ellipsis,
  );
  return (
    <Box flexDirection="column" width={width} height={height} paddingLeft={1}>
      <Text>
        <Text bold>{live}</Text>
        <Text color={C.muted}>{count}</Text>
        {flag !== "" && <Text color={C.review}>{flag}</Text>}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 && <Text color={C.muted}>nothing running</Text>}
        {visible.map((row) => (
          <Box key={row.run.id}>
            <Text color={row.run.id === current ? C.fg : C.hair}>{row.run.id === current ? g.cursor : " "}</Text>
            <RunRow row={row} forest={forest} width={rowW} now={now} compact />
          </Box>
        ))}
        {more > 0 && <Text color={C.muted}>{fit(`+${more} more`, width - 1, g.ellipsis)}</Text>}
      </Box>
      <Box flexGrow={1} />
      <Text color={C.muted}>{fit(`${usd(today)} today`, width - 1, g.ellipsis)}</Text>
    </Box>
  );
}
