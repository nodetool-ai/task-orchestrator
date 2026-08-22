// The transcript, one frame at a time, as measured lines. Same reason
// views/layout.ts exists: a line the suite cannot measure is a line that
// overflows on somebody else's terminal, and the chat view builds more
// strings than any other. The view keeps the painting — a span carries the
// colour it wants and nothing about how Ink applies it.
//
// Ink-free on purpose (model/colors.ts holds the palette), so this module can
// be imported by a plain .ts test.

import { flattenFrom, type Forest, type TreeRow } from "../model/forest.js";
import type { Frame } from "../model/frames.js";
import type { Run } from "../model/run.js";
import { C, hueFor } from "../model/colors.js";
import { UNICODE, type Glyphs } from "../model/glyphs.js";
import { clipSegments, fit, wrapText } from "./layout.js";

export interface Span {
  text: string;
  color?: string | undefined;
  bold?: boolean;
}

/** A transcript line is either spans of text or one live run row, which has
 *  its own arithmetic in layout.ts and is drawn by <RunRow>. */
export interface TSpanLine {
  key: string;
  spans: Span[];
  row?: undefined;
}
export interface TRowLine {
  key: string;
  row: TreeRow;
  width: number;
  indent: number;
  spans?: undefined;
}
export type TLine = TSpanLine | TRowLine;

export interface FrameCtx {
  forest: Forest;
  width: number;
  trace: boolean;
  /** The run whose conversation this is; other runs get their id shown. */
  selfId: number | null;
  g: Glyphs;
}

/** Painted columns. The row form is bounded by `layoutRow` instead. */
export function lineWidth(l: TLine): number {
  return l.spans === undefined ? l.indent + l.width : l.spans.reduce((n, s) => n + s.text.length, 0);
}

export function transcriptLines(frames: readonly Frame[], ctx: FrameCtx): TLine[] {
  return frames.flatMap((f, i) => frameLines(f, i, ctx));
}

function blank(key: string): TLine {
  return { key, spans: [{ text: " " }] };
}

function who(ctx: FrameCtx, id: number): { persona: string; run: Run | null } {
  const run = ctx.forest.byId(id) ?? null;
  return { persona: run?.persona ?? `#${id}`, run };
}

/** A persona is user data and can be any length; the header it sits in is one
 *  line, so it is clipped to a share of the width rather than trusted. */
function nameW(width: number): number {
  return Math.max(4, Math.floor(width / 2));
}

// One frame, in the Claude Code rhythm: your turns are `>` lines, agent prose
// is plain, tool calls are one dim `⎿` line, spawned children render as a live
// mini-tree, and questions are loud.
export function frameLines(f: Frame, i: number, ctx: FrameCtx): TLine[] {
  const k = `f${i}`;
  const { width, g } = ctx;
  const ell = g.ellipsis;
  switch (f.kind) {
    case "user": {
      const chip = f.to === undefined ? "" : `@#${f.to} `;
      const body = wrapText(f.text, Math.max(4, width - 2 - chip.length));
      return [
        blank(`${k}-gap`),
        {
          key: k,
          spans: [
            { text: "> ", color: C.you },
            ...(chip === "" ? [] : [{ text: chip, color: C.review }]),
            { text: body[0] ?? "", color: C.fg },
          ],
        },
        ...body.slice(1).map((l, j) => ({ key: `${k}-${j}`, spans: [{ text: `  ${l}`, color: C.fg }] })),
      ];
    }
    case "agent": {
      const { persona, run } = who(ctx, f.run);
      const foreign = ctx.selfId === null || f.run !== ctx.selfId;
      const body = wrapText(f.text, Math.max(4, width - 2));
      const head = clipSegments(
        [
          run ? g.status[run.status] : g.bullet,
          ` ${fit(persona, nameW(width), ell)}`,
          foreign ? ` #${f.run}` : "",
        ],
        width,
        ell,
      );
      return [
        blank(`${k}-gap`),
        {
          key: `${k}-h`,
          spans: [
            { text: head[0] ?? "", color: run ? hueFor(run.status, C) : C.muted },
            { text: head[1] ?? "", bold: true, color: C.fg },
            { text: head[2] ?? "", color: C.muted },
          ],
        },
        ...body.map((l, j) => ({ key: `${k}-${j}`, spans: [{ text: `  ${l}`, color: C.fg }] })),
      ];
    }
    case "tool": {
      const head: TLine = {
        key: k,
        spans: [{ text: `  ${g.tool} ${fit(f.text, Math.max(4, width - 6), ell)}`, color: C.muted }],
      };
      // Default is one line per call; ^o opens the arguments and the result.
      if (!ctx.trace) return [head];
      return [
        head,
        ...f.detail.map((d, j) => ({
          key: `${k}-d${j}`,
          spans: [{ text: `      ${fit(d, Math.max(4, width - 8), ell)}`, color: C.hair }],
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
        kids.length === 1 && kids[0] !== undefined
          ? `${kids[0].persona} #${kids[0].id}`
          : kids.length > 1
            ? `${kids.length} agents`
            : f.children.length > 0
              ? `${f.children.length} agents`
              : "an agent";
      const rows = flattenFrom(ctx.forest, kids, g);
      return [
        {
          key: k,
          spans: [{ text: `  ${g.tool} spawned ${fit(label, Math.max(4, width - 14), ell)}`, color: C.muted }],
        },
        ...rows.map((row) => ({ key: `${k}-r${row.run.id}`, row, indent: 4, width: Math.max(10, width - 6) })),
      ];
    }
    case "event": {
      const color = f.tone === "ok" ? C.done : f.tone === "warn" ? C.blocked : C.muted;
      return [{ key: k, spans: [{ text: `  ${g.bullet} ${fit(f.text, Math.max(4, width - 6), ell)}`, color }] }];
    }
    case "question": {
      const { persona } = who(ctx, f.run);
      const body = wrapText(f.text, Math.max(4, width - 2));
      const tail: TLine = f.answered
        ? {
            key: `${k}-a`,
            spans: [
              { text: `  ${g.answer} you: `, color: C.muted },
              { text: fit(f.answered, Math.max(0, width - 11), ell), color: C.fg },
            ],
          }
        : {
            key: `${k}-a`,
            spans: hint(clipSegments(["  ", "tab", " to answer · ", `/open #${f.run}`, " to see its work"], width, ell)),
          };
      const head = clipSegments([`${g.flag} `, fit(persona, nameW(width), ell), ` #${f.run} asks`], width, ell);
      return [
        blank(`${k}-gap`),
        {
          key: `${k}-h`,
          spans: [
            { text: head[0] ?? "", color: C.review },
            { text: head[1] ?? "", bold: true, color: C.fg },
            { text: head[2] ?? "", color: C.muted },
          ],
        },
        ...body.map((l, j) => ({
          key: `${k}-${j}`,
          spans: [{ text: `  ${l}`, color: f.answered ? C.muted : C.fg }],
        })),
        tail,
      ];
    }
  }
}

/** `  tab to answer · /open #12 to see its work`: the keys are the terminal's
 *  foreground, the prose around them is dim. */
function hint(parts: string[]): Span[] {
  return parts.map((text, i) => ({ text, color: i % 2 === 1 ? C.fg : C.muted }));
}

/** The paging footer, which is a line of the transcript's height budget and
 *  therefore has to fit like the rest of them. */
export function moreLine(behind: number, width: number, g: Glyphs = UNICODE): string {
  return fit(`  ${g.down} ${behind} more line${behind === 1 ? "" : "s"} below · pgdn`, Math.max(0, width), g.ellipsis);
}
