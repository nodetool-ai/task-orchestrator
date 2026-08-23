// Two glyph vocabularies, one shape. `--ascii` (or ORCH_ASCII=1) is for the
// terminals that still exist: a serial console, a CI log, an emulator whose
// font has no box drawing. Every mark the cockpit paints is named here rather
// than inlined at its call site, so the swap is one lookup and a missing
// ASCII fallback is a type error instead of a mojibake row.
//
// This module is deliberately free of Ink: the list verbs (cli/format.ts) and
// the row arithmetic (views/layout.ts) need the same table and must not pull a
// renderer in to get it. theme.tsx wraps it in the React context the views use.

import type { TuiStatus } from "./status.js";

export interface Glyphs {
  /** One mark per run state — the colour is the theme's, not ours. */
  status: Record<TuiStatus, string>;
  /** Box drawing: the horizontal rule under a header, the rail's column, and
   *  the thin bar the palette and the composer draw. */
  rule: string;
  rail: string;
  bar: string;
  /** Ink draws the palette's frame itself, so the fallback is the name of one
   *  of its border styles rather than a character: "classic" is `+-|`. */
  border: "round" | "classic";
  /** The forest's branch marks; the continuation column is `rail`. */
  branchTee: string;
  branchLast: string;
  /** Transcript and row marks. */
  tool: string;
  bullet: string;
  /** Claude Code's message grammar: the filled dot that opens an assistant
   *  turn or a tool call, the caret that opens yours, and the therefore-sign
   *  that opens a thinking block. */
  dot: string;
  pointer: string;
  think: string;
  /** The spinner's frames, smallest mark first. The animation plays the list
   *  forwards and then backwards, so it breathes rather than loops, and the
   *  last frame doubles as the still mark when motion is off. */
  spinner: string[];
  flag: string;
  review: string;
  pass: string;
  fail: string;
  pending: string;
  answer: string;
  /** Navigation marks in key hints, the roster cursor and the crumb. */
  down: string;
  move: string;
  enter: string;
  cursor: string;
  crumb: string;
  caret: string;
  /** What a clipped string ends in. One column in both modes matters: the row
   *  arithmetic budgets for it. */
  ellipsis: string;
}

export const UNICODE: Glyphs = {
  status: {
    running: "●",
    preparing: "◐",
    queued: "○",
    parked: "⚑",
    idle: "◌",
    done: "✓",
    failed: "✕",
  },
  rule: "─",
  rail: "│",
  bar: "▏",
  border: "round",
  branchTee: "├",
  branchLast: "└",
  tool: "⎿",
  bullet: "·",
  // ⏺ is better vertically aligned but is not usually in a Linux console
  // font, which is the same cut Claude Code makes.
  dot: process.platform === "darwin" ? "⏺" : "●",
  pointer: "❯",
  think: "∴",
  spinner: ["·", "✢", "✳", "✶", "✻", "✽"],
  flag: "⚑",
  review: "◎",
  pass: "✓",
  fail: "✕",
  pending: "⋯",
  answer: "↳",
  down: "↓",
  move: "↑↓",
  enter: "↵",
  cursor: "▸",
  crumb: "›",
  caret: "❯",
  ellipsis: "…",
};

// Single-column throughout, because the widths in views/layout.ts are counted
// in characters: a two-character fallback for a one-column glyph would push
// every row one past the 80-column guarantee.
export const ASCII: Glyphs = {
  status: {
    running: "*",
    preparing: "+",
    queued: "o",
    parked: "!",
    idle: ".",
    done: "v",
    failed: "x",
  },
  rule: "-",
  rail: "|",
  bar: "|",
  border: "classic",
  branchTee: "+",
  branchLast: "\\",
  tool: "\\",
  bullet: ".",
  dot: "*",
  pointer: ">",
  think: ":",
  spinner: ["-", "\\", "|", "/", "*"],
  flag: "!",
  review: "o",
  pass: "v",
  fail: "x",
  pending: ":",
  answer: ">",
  down: "v",
  move: "^v",
  enter: "<",
  cursor: ">",
  crumb: ">",
  caret: ">",
  ellipsis: "~",
};

export function glyphs(ascii: boolean): Glyphs {
  return ascii ? ASCII : UNICODE;
}
