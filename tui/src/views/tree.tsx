import React from "react";
import { Box, Text } from "ink";
import { childrenOf, roots, subtreeCost, type Run } from "../data.js";
import { C, StatusGlyph, age, usd, padEnd } from "../theme.js";

// Flatten the run forest into rows with tree prefixes. Shared by the Floor
// view and the right-hand roster.
export type TreeRow = { run: Run; prefix: string; depth: number };

export function flatten(filter: (r: Run) => boolean = () => true): TreeRow[] {
  return flattenFrom(roots().filter(filter));
}

// Same walk, but from an explicit set of top rows (used for inline spawn trees).
export function flattenFrom(tops: Run[]): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (r: Run, prefix: string, last: boolean, depth: number) => {
    const kids = childrenOf(r.id);
    const branch = depth === 0 ? "" : prefix + (last ? "└ " : "├ ");
    out.push({ run: r, prefix: branch, depth });
    const next = depth === 0 ? "" : prefix + (last ? "  " : "│ ");
    kids.forEach((k, i) => walk(k, next, i === kids.length - 1, depth + 1));
  };
  tops.forEach((r, i) => walk(r, "", i === tops.length - 1, 0));
  return out;
}

function statusWord(r: Run): { text: string; color: string } {
  switch (r.status) {
    case "running":
      return { text: "running", color: C.running };
    case "preparing":
      return { text: "preparing", color: C.running };
    case "queued":
      return { text: "queued", color: C.queued };
    case "parked":
      return { text: "asks you", color: C.review };
    case "idle":
      return { text: "idle", color: C.queued };
    case "done":
      return { text: "done", color: C.done };
    case "failed":
      return { text: "failed", color: C.blocked };
  }
}

export function RunRow({
  row,
  width,
  selected,
  compact,
}: {
  row: TreeRow;
  width: number;
  selected?: boolean;
  compact?: boolean;
}) {
  const { run, prefix } = row;
  const st = statusWord(run);
  const tail = compact ? "" : ` ${padEnd(st.text, 9)} ${padEnd(age(run.startedMin), 4)} ${usd(subtreeCost(run.id)).padStart(6)}`;
  const pr = run.pr ? (compact ? ` PR${run.pr.number}` : ` PR#${run.pr.number}${run.pr.ci === "pass" ? " ✓" : run.pr.ci === "fail" ? " ✕" : " ·"}`) : "";
  const head = `${prefix}`;
  const idw = 4;
  const personaW = compact ? 11 : 12;
  const fixed = head.length + 2 + idw + 1 + personaW + 1 + tail.length + pr.length + 1;
  const titleW = Math.max(6, width - fixed);
  const title = run.title.length > titleW ? run.title.slice(0, titleW - 1) + "…" : padEnd(run.title, titleW);
  return (
    <Box>
      <Text inverse={selected}>
        <Text color={C.muted}>{head}</Text>
        <StatusGlyph s={run.status} /> <Text color={C.muted}>{padEnd(`#${run.id}`, idw)}</Text>{" "}
        <Text color={run.parentId === null ? C.fg : C.muted} bold={run.parentId === null}>
          {padEnd(run.persona, personaW)}
        </Text>{" "}
        <Text>{title}</Text>
        <Text color={run.pr?.ci === "fail" ? C.blocked : C.muted}>{pr}</Text>
        {!compact && <Text color={st.color}>{tail.slice(0, 10)}</Text>}
        {!compact && <Text color={C.muted}>{tail.slice(10)}</Text>}
      </Text>
    </Box>
  );
}
