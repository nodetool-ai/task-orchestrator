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
  italic?: boolean;
  /** Painted as blanks on the off half of the blink cycle — the unfinished
   *  tool call's dot, and nothing else. The text keeps its width either way,
   *  so the scroll arithmetic never sees the animation. */
  blink?: boolean;
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

/**
 * The colour of a call's dot, and whether it pulses.
 *
 * A settled call is green, or red when the tool reported an error — the same
 * two answers Claude Code gives. A call still waiting for its result blinks,
 * but only while the run that made it is still working: once the run stops,
 * the result is never coming, and a mark that pulses forever reads as work in
 * progress that is not in progress. So it settles too — red when the run
 * broke, dim when the run simply ended without the result ever arriving.
 */
function dotState(done: boolean, error: boolean, ctx: FrameCtx, runId: number): { color: string | undefined; blink: boolean } {
  if (error) return { color: C.blocked, blink: false };
  if (done) return { color: C.done, blink: false };
  const run = ctx.forest.byId(runId);
  // A run the overview has not caught up with yet is treated as working: the
  // gap is transient, and freezing the dot on a live call would be the lie.
  if (run === undefined || run.status === "running" || run.status === "preparing") {
    return { color: C.muted, blink: true };
  }
  return { color: run.status === "failed" ? C.blocked : C.muted, blink: false };
}

/** A persona is user data and can be any length; the header it sits in is one
 *  line, so it is clipped to a share of the width rather than trusted. */
function nameW(width: number): number {
  return Math.max(4, Math.floor(width / 2));
}

// One frame, in Claude Code's own rhythm: your turns open with `❯`, an agent
// turn and a tool call open with the filled dot, a thinking block opens with
// `∴`, and everything a call came back with is folded under one `⎿`. Spawned
// children keep the cockpit's addition — a live mini-tree — and a question
// stays loud, because neither has a Claude Code counterpart.

/** `⏺ ` and `❯ `: the two-column gutter every top-level line is drawn in. */
const GUTTER = 2;
/** `  ⎿  `: the five-column gutter a result is drawn in. */
const RESULT_IN = 5;

export function frameLines(f: Frame, i: number, ctx: FrameCtx): TLine[] {
  const k = `f${i}`;
  const { width, g } = ctx;
  const ell = g.ellipsis;
  const bodyW = Math.max(4, width - GUTTER);
  switch (f.kind) {
    case "user": {
      const chip = f.to === undefined ? "" : `@#${f.to} `;
      const body = wrapText(f.text, Math.max(4, bodyW - chip.length));
      return [
        blank(`${k}-gap`),
        {
          key: k,
          spans: [
            { text: `${g.pointer} `, color: C.muted },
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
      const hue = run ? hueFor(run.status, C) : C.muted;
      const body = wrapText(f.text, bodyW);
      // The run you are reading needs no byline — its dot opens the prose,
      // exactly as Claude Code writes it. Anyone else's turn gets named.
      if (!foreign) {
        return [
          blank(`${k}-gap`),
          {
            key: k,
            spans: [
              { text: `${g.dot} `, color: hue },
              { text: body[0] ?? "", color: C.fg },
            ],
          },
          ...body.slice(1).map((l, j) => ({ key: `${k}-${j}`, spans: [{ text: `  ${l}`, color: C.fg }] })),
        ];
      }
      const head = clipSegments([`${g.dot} `, fit(persona, nameW(width), ell), ` #${f.run}`], width, ell);
      return [
        blank(`${k}-gap`),
        {
          key: `${k}-h`,
          spans: [
            { text: head[0] ?? "", color: hue },
            { text: head[1] ?? "", bold: true, color: C.fg },
            { text: head[2] ?? "", color: C.muted },
          ],
        },
        ...body.map((l, j) => ({ key: `${k}-${j}`, spans: [{ text: `  ${l}`, color: C.fg }] })),
      ];
    }
    case "thinking": {
      // Collapsed to one line by default, like Claude Code: the reasoning is
      // there when you ask for it and out of the way when you do not.
      if (!ctx.trace) {
        const head = clipSegments([`${g.think} Thinking `, "(^o to expand)"], width, ell);
        return [
          blank(`${k}-gap`),
          {
            key: k,
            spans: [
              { text: head[0] ?? "", color: C.muted, italic: true },
              { text: head[1] ?? "", color: C.hair },
            ],
          },
        ];
      }
      return [
        blank(`${k}-gap`),
        { key: `${k}-h`, spans: [{ text: fit(`${g.think} Thinking${ell}`, width, ell), color: C.muted, italic: true }] },
        ...wrapText(f.text, bodyW).map((l, j) => ({
          key: `${k}-${j}`,
          spans: [{ text: `  ${l}`, color: C.muted, italic: true }],
        })),
      ];
    }
    case "tool": {
      const call = clipSegments([`${g.dot} `, f.name, f.arg === "" ? "" : `(${f.arg})`], width, ell);
      const dot = dotState(f.done === true, f.error === true, ctx, f.run);
      const head: TLine = {
        key: k,
        spans: [
          { text: call[0] ?? "", color: dot.color, blink: dot.blink },
          { text: call[1] ?? "", bold: true, color: C.fg },
          { text: call[2] ?? "", color: C.fg },
        ],
      };
      const tone = f.error === true ? C.blocked : C.fg;
      // Default is the call plus the first line it came back with; `^o` opens
      // the rest of the result and the arguments the call line had no room for.
      if (!ctx.trace) {
        const lines: TLine[] = [head];
        const first = f.result[0];
        if (first !== undefined) lines.push(resultLine(`${k}-r`, first, tone, width, g));
        const behind = f.result.length - 1;
        if (behind > 0) lines.push(moreResult(`${k}-more`, behind, width, g));
        return lines;
      }
      return [
        head,
        ...f.result.map((r, j) => resultLine(`${k}-r${j}`, r, tone, width, g, j > 0)),
        ...f.detail.map((d, j) => ({
          key: `${k}-d${j}`,
          spans: [{ text: `     ${fit(d, Math.max(4, width - RESULT_IN), ell)}`, color: C.hair }],
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
      const call = clipSegments([`${g.dot} `, "Task", `(${fit(label, Math.max(4, width - 8), ell)})`], width, ell);
      const spawnDot = dotState(kids.length > 0, false, ctx, f.run);
      const rows = flattenFrom(ctx.forest, kids, g);
      return [
        {
          key: k,
          spans: [
            { text: call[0] ?? "", color: spawnDot.color, blink: spawnDot.blink },
            { text: call[1] ?? "", bold: true, color: C.fg },
            { text: call[2] ?? "", color: C.fg },
          ],
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
      const body = wrapText(f.text, bodyW);
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

/** One line under a call. The first carries the `⎿`; the rest line up under
 *  it, because a result that steps left of its own gutter reads as prose. */
function resultLine(key: string, text: string, color: string | undefined, width: number, g: Glyphs, cont = false): TSpanLine {
  const gutter = cont ? "     " : `  ${g.tool}  `;
  return {
    key,
    spans: [
      { text: gutter, color: C.muted },
      { text: fit(text, Math.max(0, width - RESULT_IN), g.ellipsis), color },
    ],
  };
}

/** What the collapsed form says instead of the rest of the result. */
function moreResult(key: string, behind: number, width: number, g: Glyphs): TSpanLine {
  const parts = clipSegments([`     +${behind} line${behind === 1 ? "" : "s"} `, "(^o to expand)"], width, g.ellipsis);
  return {
    key,
    spans: [
      { text: parts[0] ?? "", color: C.muted },
      { text: parts[1] ?? "", color: C.hair },
    ],
  };
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
