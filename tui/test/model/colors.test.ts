import { describe, expect, it } from "vitest";
import {
  ANSI16,
  C,
  TRUECOLOR,
  applyColorMode,
  colorMode,
  hueFor,
  orchColors,
  palette,
  type Palette,
} from "../../src/model/colors.js";
import type { TuiStatus } from "../../src/model/status.js";

// The contrast half of T-tui-13 is arithmetic, so it is asserted rather than
// eyeballed: WCAG 2.1 relative luminance, against a pure black terminal and a
// pure white one. A human still has to look at a real terminal — these
// thresholds only catch a hue that is *provably* illegible on one of them.
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const BLACK = "#000000";
const WHITE = "#ffffff";

/** xterm's defaults for the sixteen names. A terminal theme remaps them —
 *  which is the reason the fallback palette names colours instead of stating
 *  hexes — so these are the reference, not a promise. */
const XTERM: Record<string, string> = {
  black: "#000000",
  red: "#800000",
  green: "#008000",
  yellow: "#808000",
  blue: "#000080",
  magenta: "#800080",
  cyan: "#008080",
  white: "#c0c0c0",
  gray: "#808080",
  redBright: "#ff0000",
  greenBright: "#00ff00",
  yellowBright: "#ffff00",
  blueBright: "#0000ff",
  magentaBright: "#ff00ff",
  cyanBright: "#00ffff",
  whiteBright: "#ffffff",
};

const HUES = ["muted", "running", "review", "blocked", "done", "queued", "you"] as const;

describe("the 24-bit palette", () => {
  it("stays legible on a dark terminal and on a light one", () => {
    for (const key of HUES) {
      const hex = TRUECOLOR[key];
      expect(hex.startsWith("#"), key).toBe(true);
      // 4.5 is the body-text bar on the theme the cockpit is designed for;
      // 3.0 is the large-text/UI bar, which is what a status glyph and a
      // one-word status column are on a light theme.
      expect(contrast(hex, BLACK), `${key} on black`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, WHITE), `${key} on white`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the hairline quiet on dark and visible on light", () => {
    // Deliberately below the text bars: it is a rule, not a word.
    expect(contrast(TRUECOLOR.hair, BLACK)).toBeLessThan(3);
    expect(contrast(TRUECOLOR.hair, WHITE)).toBeGreaterThan(3);
  });

  it("leaves the foreground to the terminal, which is the only colour that works on both", () => {
    expect(TRUECOLOR.fg).toBeUndefined();
    expect(ANSI16.fg).toBeUndefined();
  });

  it("keeps the six hues apart", () => {
    const six = [TRUECOLOR.running, TRUECOLOR.review, TRUECOLOR.blocked, TRUECOLOR.done, TRUECOLOR.queued, TRUECOLOR.you];
    expect(new Set(six).size).toBe(6);
  });
});

describe("the 16-colour fallback", () => {
  it("names a colour chalk knows, for every hue", () => {
    for (const key of HUES) expect(XTERM[ANSI16[key]], key).toBeDefined();
  });

  it("keeps the five loud hues apart — `queued` is meant to be as quiet as `muted`", () => {
    const loud = [ANSI16.running, ANSI16.review, ANSI16.blocked, ANSI16.done, ANSI16.you];
    expect(new Set(loud).size).toBe(5);
    expect(ANSI16.queued).toBe(ANSI16.muted);
  });

  it("clears 3:1 on a black terminal and on a white one, at the xterm defaults", () => {
    for (const key of ["muted", "running", "review", "blocked", "done", "queued"] as const) {
      const hex = XTERM[ANSI16[key]] as string;
      expect(contrast(hex, BLACK), `${key} on black`).toBeGreaterThanOrEqual(3);
      expect(contrast(hex, WHITE), `${key} on white`).toBeGreaterThanOrEqual(3);
    }
    // `you` is the exception and the README says so: every blue in the ANSI
    // sixteen is dark, so bright blue is the compromise — comfortable on a
    // light theme, dim on a stock black one, and remapped by most themes.
    const you = XTERM[ANSI16.you] as string;
    expect(contrast(you, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(you, BLACK)).toBeGreaterThanOrEqual(2);
  });
});

describe("hueFor", () => {
  it("gives every run state a colour from the live palette", () => {
    const states: TuiStatus[] = ["running", "preparing", "queued", "parked", "idle", "done", "failed"];
    for (const p of [TRUECOLOR, ANSI16] as Palette[]) {
      for (const s of states) expect(typeof hueFor(s, p)).toBe("string");
      // Preparing is a shade of running, and idle is a shade of queued: the
      // vocabulary is six colours, not seven.
      expect(hueFor("preparing", p)).toBe(hueFor("running", p));
      expect(hueFor("idle", p)).toBe(hueFor("queued", p));
      expect(hueFor("parked", p)).toBe(p.review);
      expect(hueFor("failed", p)).toBe(p.blocked);
    }
  });
});

describe("colorMode", () => {
  it("takes the operator's word first", () => {
    expect(colorMode({ ORCH_COLORS: "16", COLORTERM: "truecolor" })).toBe("ansi16");
    expect(colorMode({ ORCH_COLORS: "truecolor", TERM: "dumb" })).toBe("truecolor");
  });

  it("reads the environment the way chalk does", () => {
    expect(colorMode({ COLORTERM: "truecolor", TERM: "xterm" })).toBe("truecolor");
    expect(colorMode({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(colorMode({ TERM: "xterm-256color" })).toBe("truecolor");
    expect(colorMode({ TERM: "screen-256color" })).toBe("truecolor");
    expect(colorMode({ TERM: "xterm" })).toBe("ansi16");
    expect(colorMode({ TERM: "screen" })).toBe("ansi16");
    expect(colorMode({ TERM: "dumb" })).toBe("ansi16");
    expect(colorMode({})).toBe("ansi16");
  });

  it("degrades under NO_COLOR and honours FORCE_COLOR's levels", () => {
    expect(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("ansi16");
    expect(colorMode({ NO_COLOR: "", COLORTERM: "truecolor" })).toBe("truecolor");
    expect(colorMode({ FORCE_COLOR: "1", TERM: "xterm-256color" })).toBe("ansi16");
    expect(colorMode({ FORCE_COLOR: "2", TERM: "dumb" })).toBe("truecolor");
    expect(colorMode({ FORCE_COLOR: "3", TERM: "dumb" })).toBe("truecolor");
    expect(colorMode({ FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe("ansi16");
  });
});

describe("orchColors", () => {
  it("takes the words an operator would type, and refuses the rest", () => {
    for (const v of ["16", "ansi", "ANSI16", " 8 "]) expect(orchColors(v)).toBe("ansi16");
    for (const v of ["truecolor", "24bit", "full", "256"]) expect(orchColors(v)).toBe("truecolor");
    for (const v of ["", undefined, "yes", "1"]) expect(orchColors(v)).toBe(null);
  });
});

describe("applyColorMode", () => {
  it("swaps the live palette in place, so every view sees it at the next frame", () => {
    const before = { ...C };
    try {
      applyColorMode("ansi16");
      expect(C.running).toBe(ANSI16.running);
      expect(hueFor("parked", C)).toBe(ANSI16.review);
      applyColorMode("truecolor");
      expect(C.running).toBe(TRUECOLOR.running);
    } finally {
      Object.assign(C, before);
    }
  });
});

describe("palette", () => {
  it("hands out the table the mode names", () => {
    expect(palette("ansi16")).toBe(ANSI16);
    expect(palette("truecolor")).toBe(TRUECOLOR);
  });
});
