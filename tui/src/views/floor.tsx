import React from "react";
import { Box, Text } from "ink";
import { liveCount, inbox, runs, byId, childrenOf } from "../data.js";
import { C, Keys, Hair, usd } from "../theme.js";
import { flatten, RunRow } from "./tree.js";

// The floor is the whole run forest as one tree: htop for agents. Top-level
// rows are the orchestrators you talk to; children are their workers.
export function Floor({ width, height, cursor }: { width: number; height: number; cursor: number }) {
  const { live, rest } = floorGroups();
  const today = runs.reduce((s, r) => s + r.cost, 0);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>FLOOR</Text>
          <Text color={C.muted}>
            {" "}
            {liveCount()} live · <Text color={C.review}>{inbox.length} need you</Text> · {usd(today)} today
          </Text>
        </Text>
        <Keys
          items={[
            ["↵", "talk"],
            ["c", "cancel"],
            ["n", "new"],
            ["esc", "back"],
          ]}
        />
      </Box>
      <Hair width={width} />
      <Box flexDirection="column" marginTop={1}>
        {live.map((row, i) => (
          <RunRow key={row.run.id} row={row} width={width} selected={i === cursor} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={C.muted}>earlier</Text>
      </Box>
      <Box flexDirection="column">
        {rest.map((row, i) => (
          <RunRow key={row.run.id} row={row} width={width} selected={live.length + i === cursor} />
        ))}
      </Box>
    </Box>
  );
}

// Keep subtrees intact: a root is "live" if anything under it is live.
function isLive(r: { status: string }) {
  return r.status !== "done" && r.status !== "failed" && r.status !== "idle";
}
export function floorGroups() {
  const liveRoot = (id: number): boolean => isLive(byId(id)) || childrenOf(id).some((c) => liveRoot(c.id));
  const live = flatten((r) => liveRoot(r.id));
  const rest = flatten((r) => !liveRoot(r.id));
  return { live, rest };
}
export function floorRows() {
  const { live, rest } = floorGroups();
  return [...live, ...rest];
}
