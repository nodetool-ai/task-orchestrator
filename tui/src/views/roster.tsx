import React from "react";
import { Box, Text } from "ink";
import { floorGroups, type Forest } from "../model/forest.js";
import { C, usd } from "../theme.js";
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
  // Same grouping as the floor, so the rail and the floor agree on what is
  // still on the clock — including a finished parent with a working child.
  const rows = floorGroups(forest).live;
  const today = forest.runs.reduce((s, r) => s + r.cost, 0);
  // header + its blank line + the cost footer; one more line goes to the
  // "+n more" tally when the rail cannot show everything.
  const budget = Math.max(0, height - 3);
  const visible = rows.length > budget ? rows.slice(0, Math.max(0, budget - 1)) : rows;
  return (
    <Box flexDirection="column" width={width} height={height} paddingLeft={1}>
      <Text>
        <Text bold>LIVE</Text>
        <Text color={C.muted}> {forest.liveCount()}</Text>
        {inboxCount > 0 && (
          <Text color={C.review}>
            {"  "}⚑ {inboxCount}
          </Text>
        )}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 && <Text color={C.muted}>nothing running</Text>}
        {visible.map((row) => (
          <Box key={row.run.id}>
            <Text color={row.run.id === current ? C.fg : C.hair}>{row.run.id === current ? "▸" : " "}</Text>
            <RunRow row={row} forest={forest} width={width - 3} now={now} compact />
          </Box>
        ))}
        {rows.length > visible.length && <Text color={C.muted}>+{rows.length - visible.length} more</Text>}
      </Box>
      <Box flexGrow={1} />
      <Text color={C.muted}>{usd(today)} today</Text>
    </Box>
  );
}
