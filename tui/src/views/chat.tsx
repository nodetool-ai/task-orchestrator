import React from "react";
import { Box, Text } from "ink";
import { flattenFrom, type Forest } from "../model/forest.js";
import type { Frame } from "../model/frames.js";
import type { Run } from "../model/run.js";
import { isLive } from "../model/status.js";
import { budgetLabel } from "../cli/commands.js";
import type { Glyphs } from "../model/glyphs.js";
import { C, StatusGlyph, age, useGlyphs, usd } from "../theme.js";
import { fit, tailWindow, wrapText } from "./layout.js";
import { RunRow } from "./tree.js";

interface Ctx {
  forest: Forest;
  now: number;
  width: number;
  trace: boolean;
  /** The run whose conversation this is; other runs get their id shown. */
  selfId: number | null;
  g: Glyphs;
}

// The transcript is built as a flat list of single-line elements rather than
// nested boxes: paging back (T-tui-03) has to count lines, and a line the
// view cannot count is a line the scroll arithmetic gets wrong.
type Line = { key: string; el: React.ReactNode };

function blank(key: string): Line {
  return { key, el: <Text> </Text> };
}

function who(ctx: Ctx, id: number): { persona: string; run: Run | null } {
  const run = ctx.forest.byId(id) ?? null;
  return { persona: run?.persona ?? `#${id}`, run };
}

// One frame, in the Claude Code rhythm: your turns are `>` lines, agent prose
// is plain, tool calls are one dim `⎿` line, spawned children render as a live
// mini-tree, and questions are loud.
function frameLines(f: Frame, i: number, ctx: Ctx): Line[] {
  const k = `f${i}`;
  const { width } = ctx;
  switch (f.kind) {
    case "user": {
      const chip = f.to === undefined ? "" : `@#${f.to} `;
      const body = wrapText(f.text, Math.max(4, width - 2 - chip.length));
      return [
        blank(`${k}-gap`),
        {
          key: k,
          el: (
            <Text>
              <Text color={C.you}>{"> "}</Text>
              {chip !== "" && <Text color={C.review}>{chip}</Text>}
              <Text>{body[0]}</Text>
            </Text>
          ),
        },
        ...body.slice(1).map((l, j) => ({ key: `${k}-${j}`, el: <Text>{`  ${l}`}</Text> })),
      ];
    }
    case "agent": {
      const { persona, run } = who(ctx, f.run);
      const foreign = ctx.selfId === null || f.run !== ctx.selfId;
      const body = wrapText(f.text, Math.max(4, width - 2));
      return [
        blank(`${k}-gap`),
        {
          key: `${k}-h`,
          el: (
            <Text>
              {run ? <StatusGlyph s={run.status} /> : <Text color={C.muted}>{ctx.g.bullet}</Text>}
              <Text bold> {persona}</Text>
              {foreign && <Text color={C.muted}> #{f.run}</Text>}
            </Text>
          ),
        },
        ...body.map((l, j) => ({ key: `${k}-${j}`, el: <Text>{`  ${l}`}</Text> })),
      ];
    }
    case "tool": {
      const head: Line = {
        key: k,
        el: <Text color={C.muted}>{`  ${ctx.g.tool} ${fit(f.text, Math.max(4, width - 6), ctx.g.ellipsis)}`}</Text>,
      };
      // Default is one line per call; ^o opens the arguments and the result.
      if (!ctx.trace) return [head];
      return [
        head,
        ...f.detail.map((d, j) => ({
          key: `${k}-d${j}`,
          el: <Text color={C.hair}>{`      ${fit(d, Math.max(4, width - 8), ctx.g.ellipsis)}`}</Text>,
        })),
      ];
    }
    case "spawn": {
      // Live, not frozen at spawn time: the ids are resolved against the
      // current forest, so status, age and cost are whatever they are now.
      // A child the next overview snapshot has not caught up with yet is
      // simply not drawn.
      const kids = f.children.map((id) => ctx.forest.byId(id)).filter((r): r is Run => r !== undefined);
      const label =
        kids.length === 1
          ? `${kids[0].persona} #${kids[0].id}`
          : kids.length > 1
            ? `${kids.length} agents`
            : f.children.length > 0
              ? `${f.children.length} agents`
              : "an agent";
      const rows = flattenFrom(ctx.forest, kids, ctx.g);
      return [
        { key: k, el: <Text color={C.muted}>{`  ${ctx.g.tool} spawned ${fit(label, Math.max(4, width - 14), ctx.g.ellipsis)}`}</Text> },
        ...rows.map((row) => ({
          key: `${k}-r${row.run.id}`,
          el: (
            <Box paddingLeft={4}>
              <RunRow row={row} forest={ctx.forest} width={Math.max(10, width - 6)} now={ctx.now} />
            </Box>
          ),
        })),
      ];
    }
    case "event": {
      const color = f.tone === "ok" ? C.done : f.tone === "warn" ? C.blocked : C.muted;
      return [{ key: k, el: <Text color={color}>{`  ${ctx.g.bullet} ${fit(f.text, Math.max(4, width - 6), ctx.g.ellipsis)}`}</Text> }];
    }
    case "question": {
      const { persona } = who(ctx, f.run);
      const body = wrapText(f.text, Math.max(4, width - 2));
      const tail: Line = f.answered
        ? {
            key: `${k}-a`,
            el: (
              <Text color={C.muted}>
                {`  ${ctx.g.answer} you: `}
                <Text color={C.fg}>{fit(f.answered, Math.max(4, width - 11), ctx.g.ellipsis)}</Text>
              </Text>
            ),
          }
        : {
            key: `${k}-a`,
            el: (
              <Text color={C.muted}>
                {"  "}
                <Text color={C.fg}>tab</Text> to answer · <Text color={C.fg}>/open #{f.run}</Text> to see its work
              </Text>
            ),
          };
      return [
        blank(`${k}-gap`),
        {
          key: `${k}-h`,
          el: (
            <Text>
              <Text color={C.review}>{ctx.g.flag} </Text>
              <Text bold>{persona}</Text>
              <Text color={C.muted}> #{f.run} asks</Text>
            </Text>
          ),
        },
        ...body.map((l, j) => ({
          key: `${k}-${j}`,
          el: <Text color={f.answered ? C.muted : C.fg}>{`  ${l}`}</Text>,
        })),
        tail,
      ];
    }
  }
}

export function ChatHeader({ run, forest, now, width }: { run: Run | null; forest: Forest; now: number; width: number }) {
  const g = useGlyphs();
  if (!run) {
    return (
      <Box width={width}>
        <Text color={C.muted}>no run open · ^f for the floor · ^k to jump</Text>
      </Box>
    );
  }
  const kids = forest.childrenOf(run.id);
  const parent = forest.ancestors(run.id)[0] ?? null;
  // `/model` and `/budget` are only worth typing if you can see what they did,
  // so whatever the run carries sits between the agent count and the spend.
  const tuning = [run.model ?? "", budgetLabel(run)].filter((x) => x !== "").join(" · ");
  const right = `${isLive(run.status) ? `${age(run.startedAt, now)} · ` : ""}${
    kids.length > 0 ? `${kids.length} agents · ` : ""
  }${tuning === "" ? "" : `${tuning} · `}${usd(forest.subtreeCost(run.id))}`;

  // Measured, not left to flexbox: `justifyContent="space-between"` wraps the
  // header onto a second line the moment the two halves do not fit, and a
  // two-line header shifts everything below it.
  let crumb = parent ? `${parent.persona} #${parent.id} ${g.crumb} ` : "";
  const head = ` ${run.persona} #${run.id} · `;
  const budget = () => width - right.length - 1 - crumb.length - 1 - head.length;
  if (budget() < 8) crumb = "";
  const title = fit(run.title, Math.max(0, budget()), g.ellipsis);

  return (
    <Box width={width} justifyContent="space-between">
      <Box>
        {crumb !== "" && <Text color={C.muted}>{crumb}</Text>}
        <StatusGlyph s={run.status} />
        <Text bold> {run.persona}</Text>
        <Text color={C.muted}> #{run.id} · </Text>
        <Text>{title}</Text>
      </Box>
      <Text color={C.muted}>{right}</Text>
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
  const ctx: Ctx = { forest, now, width, trace, selfId: run?.id ?? null, g: useGlyphs() };
  const lines = frames.flatMap((f, i) => frameLines(f, i, ctx));
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
        <Box key={l.key}>{l.el}</Box>
      ))}
      {!full.pinned && (
        <Text color={C.muted}>{`  ${ctx.g.down} ${behind} more line${behind === 1 ? "" : "s"} below · pgdn`}</Text>
      )}
    </Box>
  );
}
