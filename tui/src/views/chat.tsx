import React from "react";
import { Box, Text } from "ink";
import type { Forest } from "../model/forest.js";
import type { Frame } from "../model/frames.js";
import type { Run } from "../model/run.js";
import { isLive } from "../model/status.js";
import { budgetLabel } from "../cli/commands.js";
import { C, StatusGlyph, age, useGlyphs, usd } from "../theme.js";
import { chatHeaderEmpty, layoutChatHeader, tailWindow } from "./layout.js";
import { moreLine, transcriptLines, type TRowLine, type TSpanLine } from "./transcript.js";
import { RunRow } from "./tree.js";

// The transcript is built as a flat list of single-line elements rather than
// nested boxes: paging back (T-tui-03) has to count lines, and a line the
// view cannot count is a line the scroll arithmetic gets wrong. The lines
// themselves are built — and measured — in views/transcript.ts; this file
// only turns spans into <Text>.
function paint(l: TSpanLine): React.ReactNode {
  return (
    <Text>
      {l.spans.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

export function ChatHeader({ run, forest, now, width }: { run: Run | null; forest: Forest; now: number; width: number }) {
  const g = useGlyphs();
  if (!run) {
    return (
      <Box width={width}>
        <Text color={C.muted}>{chatHeaderEmpty(width, g)}</Text>
      </Box>
    );
  }
  const kids = forest.childrenOf(run.id);
  const parent = forest.ancestors(run.id)[0] ?? null;
  // `/model` and `/budget` are only worth typing if you can see what they did,
  // so whatever the run carries sits between the agent count and the spend.
  const tuning = [run.model ?? "", budgetLabel(run)].filter((x) => x !== "").join(" · ");
  const cells = layoutChatHeader({
    persona: run.persona,
    id: run.id,
    title: run.title,
    crumb: parent ? `${parent.persona} #${parent.id} ${g.crumb} ` : "",
    right: `${isLive(run.status) ? `${age(run.startedAt, now)} · ` : ""}${
      kids.length > 0 ? `${kids.length} agents · ` : ""
    }${tuning === "" ? "" : `${tuning} · `}${usd(forest.subtreeCost(run.id))}`,
    width,
    glyphs: g,
  });

  return (
    <Box width={width} justifyContent="space-between">
      <Box>
        {cells.crumb !== "" && <Text color={C.muted}>{cells.crumb}</Text>}
        <StatusGlyph s={run.status} />
        <Text color={C.muted}>{cells.head}</Text>
        <Text color={C.fg}>{cells.title}</Text>
      </Box>
      <Text color={C.muted}>{cells.right}</Text>
    </Box>
  );
}

export function Transcript({
  run,
  frames,
  forest,
  now,
  width,
  height,
  trace,
  scrollBack,
}: {
  run: Run | null;
  frames: Frame[];
  forest: Forest;
  now: number;
  width: number;
  height: number;
  trace: boolean;
  scrollBack: number;
}) {
  const g = useGlyphs();
  const lines = transcriptLines(frames, { forest, width, trace, selfId: run?.id ?? null, g });
  const h = Math.max(1, height);

  // Pinned to the tail by default; scrollBack is clamped inside tailWindow so
  // paging past either end is a no-op instead of an empty screen.
  const full = tailWindow(lines.length, h, scrollBack);
  const win = full.pinned ? full : tailWindow(lines.length, h - 1, scrollBack);
  const visible = lines.slice(win.start, win.end);
  const behind = lines.length - win.end;

  return (
    <Box flexDirection="column" width={width} height={h} overflow="hidden" justifyContent="flex-end">
      {lines.length === 0 && <Text color={C.muted}>{run ? "nothing yet." : ""}</Text>}
      {visible.map((l) => (
        <Box key={l.key}>{l.row === undefined ? paint(l) : <RunRowLine line={l} forest={forest} now={now} />}</Box>
      ))}
      {!full.pinned && <Text color={C.muted}>{moreLine(behind, width, g)}</Text>}
    </Box>
  );
}

/** A spawned child, drawn live from the current forest so its status, age and
 *  cost are whatever they are now rather than what they were at spawn time. */
function RunRowLine({ line, forest, now }: { line: TRowLine; forest: Forest; now: number }) {
  return (
    <Box paddingLeft={line.indent}>
      <RunRow row={line.row} forest={forest} width={line.width} now={now} />
    </Box>
  );
}
