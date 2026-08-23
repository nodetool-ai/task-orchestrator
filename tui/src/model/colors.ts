// The six-hue vocabulary, twice: once in 24-bit hex for a terminal that can
// paint it, once in ANSI names for one that cannot. Colour carries meaning in
// this cockpit (state, and only state), so on a 16-colour terminal the hues
// have to degrade *deliberately*: chalk will quantise a hex on its own, and
// its quantiser is a per-channel round that sends `you` (#6ea8fe) to bright
// cyan and `queued` (#95959d) to bright white — two hues landing on colours
// that mean something else, and one of them invisible on a light background.
//
// This module is deliberately free of Ink, like model/glyphs.ts: the row
// arithmetic and the transcript builder need the palette and must not pull a
// renderer in to get it. theme.tsx re-exports `C` for the views.

import type { TuiStatus } from "./status.js";

export type ColorMode = "truecolor" | "ansi16";

export interface Palette {
  /** Undefined on purpose: the terminal's own foreground. A literal "white"
   *  is invisible on a light theme, where ANSI 37 is nearly the background. */
  fg: string | undefined;
  muted: string;
  hair: string;
  running: string;
  review: string;
  blocked: string;
  done: string;
  queued: string;
  you: string;
  /** The highlight the spinner's glimmer drags across its verb. Not a state
   *  colour: it is `running` lifted, and it never appears on its own. */
  shimmer: string;
}

// Contrast against pure black / pure white, WCAG 2.1 ratios (see README):
// every hue clears 6.5:1 on black and 3.15:1 on white. The four that used to
// sit near 2.1–2.9:1 on white were darkened by 4–19 % — enough to be legible
// on a light theme, not enough to stop reading as the same colour on a dark
// one.
export const TRUECOLOR: Palette = {
  fg: undefined,
  muted: "#808080",
  hair: "#3a3a3f",
  running: "#c68108",
  review: "#a662ea",
  blocked: "#e25050",
  done: "#29a46a",
  queued: "#8f8f97",
  you: "#6092dd",
  shimmer: "#f3ce8a",
};

// Nearest ANSI name per hue, picked in CIE L*a*b* within the hue's own family
// and then decided on contrast where base and bright are both close — an
// unconstrained nearest match collapses `you` onto white, which would make two
// hues mean one thing. Reference values are the xterm defaults; a terminal
// theme remaps them, which is the point of using names here.
export const ANSI16: Palette = {
  fg: undefined,
  muted: "gray",
  // Same gray as `muted`: `black` is the nearest match but disappears on a
  // dark background, and a rule you cannot see is worse than a loud one.
  hair: "gray",
  running: "yellow",
  review: "magentaBright",
  blocked: "redBright",
  done: "green",
  queued: "gray",
  you: "blueBright",
  shimmer: "yellowBright",
};

export function palette(mode: ColorMode): Palette {
  return mode === "ansi16" ? ANSI16 : TRUECOLOR;
}

/** Colour per run state. The mark itself lives in model/glyphs.ts, because
 *  `--ascii` swaps the marks and never the colours. */
export function hueFor(s: TuiStatus, p: Palette): string {
  switch (s) {
    case "running":
    case "preparing":
      return p.running;
    case "parked":
      return p.review;
    case "done":
      return p.done;
    case "failed":
      return p.blocked;
    case "queued":
    case "idle":
      return p.queued;
  }
}

export interface ColorEnv {
  ORCH_COLORS?: string | undefined;
  NO_COLOR?: string | undefined;
  FORCE_COLOR?: string | undefined;
  COLORTERM?: string | undefined;
  TERM?: string | undefined;
}

/**
 * Which palette this terminal gets. chalk already answers a version of this
 * question — `chalk.level` — but chalk is not a dependency of this package
 * (it arrives under ink), and the answer has to be a pure function the suite
 * can drive with a fake environment anyway. So the rules below are chalk's,
 * restated: the two agree on every case that matters, and disagreeing would
 * only mean we emit 24-bit escapes chalk then throws away.
 *
 * The cut is at 256 colours, not at 24-bit: chalk downsamples a hex to the
 * nearest of 256 by itself, and that quantisation keeps the hue. Below that it
 * does not, so anything at 16 colours or less takes the named palette.
 */
export function colorMode(env: ColorEnv): ColorMode {
  const forced = orchColors(env.ORCH_COLORS);
  if (forced !== null) return forced;
  // A stripped terminal paints nothing either way; naming the colours means
  // nothing has to strip a 24-bit escape it did not ask for.
  if ((env.NO_COLOR ?? "") !== "") return "ansi16";

  const force = (env.FORCE_COLOR ?? "").trim();
  if (force !== "") return force === "2" || force === "3" ? "truecolor" : "ansi16";

  const colorterm = (env.COLORTERM ?? "").trim().toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";

  const term = (env.TERM ?? "").trim().toLowerCase();
  // No TERM at all is a pipe, a CI log or a serial line: assume the least.
  if (term === "" || term === "dumb") return "ansi16";
  return /(-256(color)?|-direct)$/.test(term) ? "truecolor" : "ansi16";
}

/** `ORCH_COLORS=16` (or `--16color`) is the operator's override, in the shape
 *  ORCH_ASCII already established: a word, not a number of bits. */
export function orchColors(value: string | undefined): ColorMode | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return null;
  if (v === "16" || v === "ansi" || v === "ansi16" || v === "8") return "ansi16";
  if (v === "truecolor" || v === "24bit" || v === "full" || v === "256") return "truecolor";
  return null;
}

/**
 * The live palette. A mutable module singleton rather than a React context:
 * every view already reads colours as `C.muted`, the mode is decided once from
 * argv and the environment before the first frame, and threading a context
 * through twenty call sites to carry one constant is the same trade glyphs.ts
 * documents — except here the constant is read outside the tree too.
 */
export const C: Palette = { ...palette(colorMode(process.env)) };

/** Swap the palette. Call before rendering; the views read `C` per frame, so
 *  a later call would repaint, but nothing is written to expect that. */
export function applyColorMode(mode: ColorMode): void {
  Object.assign(C, palette(mode));
}
