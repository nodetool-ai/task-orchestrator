// Row and transcript geometry. This lives in a .ts file, not in the .tsx
// views, because the 80-column guarantee (T-tui-02) is arithmetic and the
// suite only picks up test/**/*.test.ts.

/** Glyph plus its trailing space: always drawn, never negotiable. */
const GLYPH_W = 2;
const ID_W = 4;

/** Below this the title stops being readable, so a tail column is dropped
 *  instead. The rail is narrow by design and settles for less. */
const MIN_TITLE = 18;
const MIN_TITLE_COMPACT = 8;

export type Ci = "pending" | "pass" | "fail" | "unknown";

export interface RowInput {
  prefix: string;
  id: number;
  persona: string;
  title: string;
  pr: { number: number; ci: Ci } | null;
  status: string;
  age: string;
  cost: string;
  width: number;
  compact?: boolean;
}

/** Every cell is already padded to its final width; concatenating them plus
 *  the one-column glyph reproduces the row exactly. An empty string is a
 *  column that did not survive the width budget. */
export interface RowCells {
  prefix: string;
  id: string;
  persona: string;
  title: string;
  pr: string;
  status: string;
  age: string;
  cost: string;
  /** Rendered width, glyph included. Never exceeds the requested width. */
  total: number;
}

/** CI is `unknown` for every row in M1 — the overview payload carries no
 *  check state — so the neutral marker has to read as "no answer yet", not as
 *  a pass or a fail. */
export function ciMark(ci: Ci): string {
  switch (ci) {
    case "pass":
      return "✓";
    case "fail":
      return "✕";
    case "pending":
      return "⋯";
    case "unknown":
      return "·";
  }
}

export function layoutRow(o: RowInput): RowCells {
  const compact = o.compact === true;
  const width = Math.max(0, Math.floor(o.width));
  const personaW = compact ? 11 : 12;
  const minTitle = compact ? MIN_TITLE_COMPACT : MIN_TITLE;

  // Deep nesting must not push the row off the right edge, so the branch
  // prefix is the first thing that gets clipped.
  let avail = Math.max(0, width - GLYPH_W);
  const prefix = fit(o.prefix, Math.max(0, avail - 10));
  avail -= prefix.length;

  const id = fit(`${padEnd(`#${o.id}`, ID_W)} `, avail);
  avail -= id.length;
  const persona = fit(`${padEnd(o.persona, personaW)} `, avail);
  avail -= persona.length;

  // Tail columns in the order they are given up: cost first, then the status
  // word, then the age, and the PR only when nothing else is left.
  let cost = compact ? "" : ` ${o.cost.padStart(6)}`;
  let status = compact ? "" : ` ${padEnd(o.status, 9)}`;
  let age = compact ? "" : ` ${o.age.padStart(4)}`;
  let pr = o.pr === null ? "" : compact ? ` PR${o.pr.number}` : ` PR#${o.pr.number} ${ciMark(o.pr.ci)}`;

  const slack = () => avail - (cost.length + status.length + age.length + pr.length);
  if (slack() < minTitle) cost = "";
  if (slack() < minTitle) status = "";
  if (slack() < minTitle) age = "";
  if (slack() < minTitle) pr = "";

  // The title absorbs all of it: padded when there is room to spare, clipped
  // when there is not, so the composed row is exactly `width` columns.
  const titleW = Math.max(0, slack());
  const title = o.title.length > titleW ? fit(o.title, titleW) : padEnd(o.title, titleW);

  const total =
    GLYPH_W + prefix.length + id.length + persona.length + title.length + pr.length + status.length + age.length + cost.length;
  return { prefix, id, persona, title, pr, status, age, cost, total };
}

/** Greedy word wrap. Words longer than the line are hard-split rather than
 *  allowed to overflow, because Ink would wrap them for us and the transcript
 *  scroll arithmetic counts lines. */
export function wrapText(s: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter((x) => x.length > 0)) {
      let word2 = word;
      while (word2.length > w) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word2.slice(0, w));
        word2 = word2.slice(w);
      }
      if (!line) line = word2;
      else if (line.length + 1 + word2.length <= w) line += ` ${word2}`;
      else {
        out.push(line);
        line = word2;
      }
    }
    out.push(line);
  }
  return out.length === 0 ? [""] : out;
}

/** The visible slice of a list that tails to the bottom. `back` is how many
 *  lines the operator has paged up; it is clamped here so paging past either
 *  end is a no-op rather than an empty screen. */
export function tailWindow(total: number, size: number, back: number): { start: number; end: number; pinned: boolean } {
  const h = Math.max(0, Math.floor(size));
  const maxStart = Math.max(0, total - h);
  const start = clamp(maxStart - Math.max(0, Math.floor(back)), 0, maxStart);
  return { start, end: Math.min(total, start + h), pinned: start === maxStart };
}

/** The visible slice of a cursor-driven list, cursor kept roughly centred. */
export function cursorWindow(total: number, size: number, cursor: number): { start: number; end: number } {
  const h = Math.max(0, Math.floor(size));
  const maxStart = Math.max(0, total - h);
  const start = clamp(Math.floor(cursor) - Math.floor(h / 2), 0, maxStart);
  return { start, end: Math.min(total, start + h) };
}

export function fit(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return n === 1 ? "…" : `${s.slice(0, n - 1)}…`;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
