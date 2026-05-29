// Palette ported verbatim from the Pi Factory mobile prototype CSS variables.
// RN accepts hsl()/hsla() color strings (comma syntax), so we keep the same
// values the design was tuned against.

export type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  raised: string;
  raised2: string;
  hairline: string;
  hairlineStrong: string;
  fg: string;
  muted: string;
  muted2: string;
  accent: string;
  // status colors
  sTodo: string;
  sProgress: string;
  sReview: string;
  sBlocked: string;
  sDone: string;
  sCancelled: string;
  // blur tint used under frosted bars
  blurTint: "dark" | "light";
};

export const dark: Palette = {
  bg: "hsl(240, 6%, 6%)",
  surface: "hsl(240, 6%, 8%)",
  surface2: "hsl(240, 5%, 10%)",
  raised: "hsl(240, 4%, 14%)",
  raised2: "hsl(240, 4%, 18%)",
  hairline: "hsla(240, 4%, 30%, 0.5)",
  hairlineStrong: "hsla(240, 4%, 38%, 0.7)",
  fg: "hsl(0, 0%, 98%)",
  muted: "hsl(240, 5%, 64%)",
  muted2: "hsl(240, 4%, 46%)",
  accent: "hsl(0, 0%, 98%)",
  sTodo: "hsl(240, 4%, 60%)",
  sProgress: "hsl(38, 92%, 50%)",
  sReview: "hsl(270, 76%, 65%)",
  sBlocked: "hsl(0, 72%, 60%)",
  sDone: "hsl(152, 60%, 45%)",
  sCancelled: "hsl(240, 4%, 50%)",
  blurTint: "dark",
};

export const light: Palette = {
  bg: "hsl(240, 16%, 98%)",
  surface: "hsl(0, 0%, 100%)",
  surface2: "hsl(240, 16%, 97%)",
  raised: "hsl(240, 14%, 94%)",
  raised2: "hsl(240, 14%, 90%)",
  hairline: "hsla(240, 8%, 46%, 0.18)",
  hairlineStrong: "hsla(240, 8%, 38%, 0.3)",
  fg: "hsl(240, 9%, 12%)",
  muted: "hsl(240, 5%, 40%)",
  muted2: "hsl(240, 4%, 56%)",
  accent: "hsl(240, 9%, 12%)",
  sTodo: "hsl(240, 4%, 52%)",
  sProgress: "hsl(34, 96%, 44%)",
  sReview: "hsl(270, 66%, 56%)",
  sBlocked: "hsl(0, 68%, 52%)",
  sDone: "hsl(152, 58%, 38%)",
  sCancelled: "hsl(240, 4%, 58%)",
  blurTint: "light",
};

// State → color key resolver shared by StateIcon / StatePill / cards.
export type RunState =
  | "todo"
  | "in_progress"
  | "review"
  | "blocked"
  | "done"
  | "cancelled";

export function stateColor(p: Palette, state: RunState): string {
  switch (state) {
    case "todo":
      return p.sTodo;
    case "in_progress":
      return p.sProgress;
    case "review":
      return p.sReview;
    case "blocked":
      return p.sBlocked;
    case "done":
      return p.sDone;
    case "cancelled":
      return p.sCancelled;
    default:
      return p.muted;
  }
}

// The design leans on CSS color-mix() for soft tinted backgrounds. RN has no
// equivalent, so we approximate "<pct> of color over surface" by laying the
// state color at a low alpha — visually equivalent on the dark surface.
export function tint(state: RunState, p: Palette, alpha = 0.22): string {
  const base = stateColor(p, state);
  return toAlpha(base, alpha);
}

// Convert our hsl(...) tokens to hsla(...) with the given alpha.
export function toAlpha(hsl: string, alpha: number): string {
  const m = hsl.match(/hsla?\(([^)]+)\)/);
  if (!m) return hsl;
  const parts = m[1].split(",").map((s) => s.trim());
  const [h, s, l] = parts;
  return `hsla(${h}, ${s}, ${l}, ${alpha})`;
}
