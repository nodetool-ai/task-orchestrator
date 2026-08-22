import React from "react";
import { Box, Text } from "ink";
import { inbox, liveCount, runs } from "../data.js";
import { C, usd } from "../theme.js";
import { flatten, RunRow } from "./tree.js";

// Right-hand rail: the live part of the forest, compact. Shown when the
// terminal is wide; ctrl+b toggles it. The current run is marked with ▸.
export function Roster({ width, height, current }: { width: number; height: number; current: number }) {
  const rows = flatten().filter((r) => !["done", "failed"].includes(r.run.status));
  const today = runs.reduce((s, r) => s + r.cost, 0);
  return (
    <Box flexDirection="column" width={width} height={height} paddingLeft={1}>
      <Text>
        <Text bold>LIVE</Text>
        <Text color={C.muted}> {liveCount()}</Text>
        {inbox.length > 0 && (
          <Text color={C.review}>
            {"  "}⚑ {inbox.length}
          </Text>
        )}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => (
          <Box key={row.run.id}>
            <Text color={row.run.id === current ? C.fg : C.hair}>{row.run.id === current ? "▸" : " "}</Text>
            <RunRow row={row} width={width - 3} compact />
          </Box>
        ))}
      </Box>
      <Box flexGrow={1} />
      <Text color={C.muted}>{usd(today)} today</Text>
    </Box>
  );
}
