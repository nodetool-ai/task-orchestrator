// Row and transcript geometry. This lives in a .ts file, not in the .tsx
// views, because the 80-column guarantee (T-tui-02) is arithmetic and the
// suite only picks up test/**/*.test.ts.

import { UNICODE, type Glyphs } from "../model/glyphs.js";

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
  /** `--ascii` swaps the CI mark and the clip character. Defaults to unicode,
   *  so a caller that never heard of the flag still renders. */
  glyphs?: Glyphs;
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
export function ciMark(ci: Ci, g: Glyphs = UNICODE): string {
  switch (ci) {
    case "pass":
      return g.pass;
    case "fail":
      return g.fail;
    case "pending":
      return g.pending;
    case "unknown":
      return g.bullet;
  }
}

export function layoutRow(o: RowInput): RowCells {
  const g = o.glyphs ?? UNICODE;
  const compact = o.compact === true;
  const width = Math.max(0, Math.floor(o.width));
  const personaW = compact ? 11 : 12;
  const minTitle = compact ? MIN_TITLE_COMPACT : MIN_TITLE;

  // Deep nesting must not push the row off the right edge, so the branch
  // prefix is the first thing that gets clipped.
  let avail = Math.max(0, width - GLYPH_W);
  const prefix = fit(o.prefix, Math.max(0, avail - 10), g.ellipsis);
  avail -= prefix.length;

  // Four-digit run ids are ordinary by now, and `#1234` clipped to `#123` is
  // a wrong id, not a narrow one: the cell grows and the title pays for it.
  const idText = `#${o.id}`;
  const id = fit(`${padEnd(idText, Math.max(ID_W, idText.length))} `, avail, g.ellipsis);
  avail -= id.length;
  const persona = fit(`${padEnd(o.persona, personaW)} `, avail, g.ellipsis);
  avail -= persona.length;

  // Tail columns in the order they are given up: cost first, then the status
  // word, then the age, and the PR only when nothing else is left.
  let cost = compact ? "" : ` ${o.cost.padStart(6)}`;
  let status = compact ? "" : ` ${padEnd(o.status, 9)}`;
  let age = compact ? "" : ` ${o.age.padStart(4)}`;
  let pr = o.pr === null ? "" : compact ? ` PR${o.pr.number}` : ` PR#${o.pr.number} ${ciMark(o.pr.ci, g)}`;

  const slack = () => avail - (cost.length + status.length + age.length + pr.length);
  if (slack() < minTitle) cost = "";
  if (slack() < minTitle) status = "";
  if (slack() < minTitle) age = "";
  if (slack() < minTitle) pr = "";

  // The title absorbs all of it: padded when there is room to spare, clipped
  // when there is not, so the composed row is exactly `width` columns.
  const titleW = Math.max(0, slack());
  const title = o.title.length > titleW ? fit(o.title, titleW, g.ellipsis) : padEnd(o.title, titleW);

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

/** Clip to `n` columns, marking the cut. `ell` is one column in every glyph
 *  mode, which is why the arithmetic above can budget for it blindly. */
export function fit(s: string, n: number, ell = "…"): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return n === 1 ? ell : `${s.slice(0, n - 1)}${ell}`;
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── Screen geometry ────────────────────────────────────────────────────────
// The rail is a fixed column, not a fraction: at 110 the main pane still has
// 71 columns, which is where the row budget above stops being comfortable.

export const RAIL_W = 38;
export const RAIL_MIN_COLS = 110;

/** Header, the hairline under it, and the status line: three rows the main
 *  column always paints, whatever the view. */
const CHROME_H = 3;
/** A transcript smaller than this is not worth drawing, so a very short
 *  terminal overdraws rather than showing nothing. */
const MIN_BODY_H = 3;
/** Hairline, the input line, and the key hints under it. */
const PROMPT_H = 3;

export interface Screen {
  cols: number;
  rows: number;
  railW: number;
  /** Width of everything left of the rail, including its separator column. */
  mainW: number;
  bodyH: number;
  promptH: number;
  /** How many command-help lines fit; the composer shows at most this many. */
  helpShown: number;
}

/**
 * Every width and height the cockpit derives from the terminal, in one place,
 * so the vertical budget can be asserted instead of eyeballed. The command
 * help is the elastic part: on a short terminal it yields before the
 * transcript does, because a ten-line help list under a five-line transcript
 * is the wrong trade.
 */
export function screenLayout(
  cols: number,
  rows: number,
  o: { rail: boolean; help?: number; pending?: boolean; spinner?: boolean },
): Screen {
  const c = Math.max(0, Math.floor(cols));
  const r = Math.max(0, Math.floor(rows));
  const railW = o.rail && c >= RAIL_MIN_COLS ? RAIL_W : 0;
  const mainW = Math.max(0, c - railW - (railW ? 1 : 0));
  const pending = o.pending === true ? 1 : 0;
  // The live line sits between the transcript and the composer, so it is part
  // of the composer's budget: the transcript has to give up a row for it or
  // the status line drops off a 24-row screen.
  const spinner = o.spinner === true ? 1 : 0;
  const room = r - CHROME_H - MIN_BODY_H - PROMPT_H - pending - spinner;
  const helpShown = Math.max(0, Math.min(Math.max(0, Math.floor(o.help ?? 0)), room));
  const promptH = PROMPT_H + helpShown + pending + spinner;
  const bodyH = Math.max(MIN_BODY_H, r - CHROME_H - promptH);
  return { cols: c, rows: r, railW, mainW, bodyH, promptH, helpShown };
}

// ── The live line ──────────────────────────────────────────────────────────

export interface SpinnerInput {
  /** `Cogitating` — one word, chosen once per run (model/verbs.ts). */
  verb: string;
  /** The byline inside the parentheses, most useful first. */
  parts: string[];
  width: number;
  glyphs?: Glyphs;
}

export interface SpinnerCells {
  /** The glyph's column plus its space; the glyph itself animates. */
  head: string;
  verb: string;
  /** `(12s · 3 agents · $0.42)`, or empty when nothing fits. */
  tail: string;
  total: number;
}

/**
 * Claude Code's spinner line, measured. The byline is progressive: a part is
 * dropped from the right rather than wrapped, because the line is one row of
 * the composer's budget and a second row would push the status line off.
 */
export function layoutSpinner(o: SpinnerInput): SpinnerCells {
  const g = o.glyphs ?? UNICODE;
  const width = Math.max(0, Math.floor(o.width));
  // The glyph's own column plus its space. A pane too narrow for even that
  // gets what is left of it, so the line still fits rather than overflowing.
  const head = " ".repeat(Math.min(2, width));
  const verb = fit(o.verb, Math.max(0, width - head.length), g.ellipsis);
  const kept = o.parts.filter((p) => p !== "");
  let tail = "";
  while (kept.length > 0) {
    const candidate = ` (${kept.join(" · ")})`;
    if (head.length + verb.length + candidate.length <= width) {
      tail = candidate;
      break;
    }
    kept.pop();
  }
  return { head, verb, tail, total: head.length + verb.length + tail.length };
}

// ── Shared clipping ────────────────────────────────────────────────────────

/** Clip a run of segments to one line: each takes what is left, the one that
 *  straddles the edge is cut, and everything after it is empty. Lets a
 *  multi-coloured line be measured as a whole without gluing it into one
 *  string the view can no longer paint in pieces. */
export function clipSegments(parts: string[], width: number, ell = "…"): string[] {
  let left = Math.max(0, Math.floor(width));
  return parts.map((p) => {
    const s = fit(p, left, ell);
    left -= s.length;
    return s;
  });
}

export type KeyHint = [key: string, label: string];

/** What <Keys> paints: `k label` per item, `gap` columns between them. */
export function keysWidth(items: readonly KeyHint[], gap = 2): number {
  if (items.length === 0) return 0;
  return items.reduce((n, [k, l]) => n + k.length + 1 + l.length, 0) + gap * (items.length - 1);
}

/** Key hints are ordered by how often they are needed, so a narrow terminal
 *  drops them from the right rather than wrapping the header onto a second
 *  line — which would push everything below it off the screen. */
export function fitKeys(items: readonly KeyHint[], width: number, gap = 2): KeyHint[] {
  const w = Math.max(0, Math.floor(width));
  const kept = [...items];
  while (kept.length > 0 && keysWidth(kept, gap) > w) kept.pop();
  return kept;
}

// ── Chat header ────────────────────────────────────────────────────────────

export interface ChatHeadInput {
  persona: string;
  id: number;
  title: string;
  /** `parent-persona #id ›`, already assembled; dropped first when tight. */
  crumb: string;
  /** Age, agent count, model, budget and cost — the right-hand tally. */
  right: string;
  width: number;
  glyphs?: Glyphs;
}

export interface ChatHeadCells {
  crumb: string;
  /** Persona and id, including the space after the status glyph. */
  head: string;
  title: string;
  right: string;
  /** Glyph and the one-column gap included. Never exceeds the width. */
  total: number;
}

/** Measured, not left to flexbox: `justifyContent="space-between"` wraps the
 *  header onto a second line the moment the two halves do not fit, and a
 *  two-line header shifts everything below it. The tally is capped at half
 *  the width first — a long model id must not squeeze the run's own name out
 *  of its own header. */
export function layoutChatHeader(o: ChatHeadInput): ChatHeadCells {
  const g = o.glyphs ?? UNICODE;
  const width = Math.max(0, Math.floor(o.width));
  // One column for the status glyph, one for the gap before the tally — both
  // only when there is a column to spend on them.
  const glyph = width >= 1 ? 1 : 0;
  const right = fit(o.right, Math.floor(Math.max(0, width - glyph) / 2), g.ellipsis);
  const gap = right.length > 0 ? 1 : 0;
  let avail = Math.max(0, width - right.length - gap - glyph);
  const head = fit(` ${o.persona} #${o.id} · `, avail, g.ellipsis);
  avail -= head.length;
  let crumb = fit(o.crumb, avail, g.ellipsis);
  if (avail - crumb.length < 8) crumb = "";
  const title = fit(o.title, Math.max(0, avail - crumb.length), g.ellipsis);
  return {
    crumb,
    head,
    title,
    right,
    total: crumb.length + glyph + head.length + title.length + gap + right.length,
  };
}

/** The header with no run open: a hint, clipped like everything else. */
export function chatHeaderEmpty(width: number, g: Glyphs = UNICODE): string {
  return fit("no run open · ^f for the floor · ^k to jump", Math.max(0, Math.floor(width)), g.ellipsis);
}

// ── Needs-you rows ─────────────────────────────────────────────────────────

export interface InboxRowInput {
  /** The kind's mark; one column in both glyph tables. */
  mark: string;
  runId: number;
  persona: string;
  label: string;
  text: string;
  age: string;
  width: number;
  glyphs?: Glyphs;
}

export interface InboxRowCells {
  mark: string;
  id: string;
  persona: string;
  label: string;
  text: string;
  age: string;
  total: number;
}

const INBOX_PERSONA_W = 12;
const INBOX_LABEL_W = 7;
const INBOX_AGE_W = 4;
const MIN_INBOX_TEXT = 8;

/** Same discipline as `layoutRow`: fixed cells first, the text absorbs the
 *  rest, and the columns that are context rather than content are given up
 *  from the right when the terminal is too narrow to hold them. */
export function layoutInboxRow(o: InboxRowInput): InboxRowCells {
  const g = o.glyphs ?? UNICODE;
  const width = Math.max(0, Math.floor(o.width));
  const empty = { mark: "", id: "", persona: "", label: "", text: "", age: "", total: 0 };
  if (width < 2) return empty;

  let avail = width - 2;
  // Four-digit run ids are ordinary by now, and a truncated id is a wrong id:
  // the cell grows instead, and the text pays for it.
  const idText = `#${o.runId}`;
  const id = fit(`${padEnd(idText, Math.max(4, idText.length))} `, avail, g.ellipsis);
  avail -= id.length;
  const persona = fit(padEnd(o.persona, INBOX_PERSONA_W), avail, g.ellipsis);
  avail -= persona.length;

  let label = padEnd(o.label, INBOX_LABEL_W);
  let age = fit(o.age, INBOX_AGE_W, g.ellipsis).padStart(INBOX_AGE_W);
  const slack = () => avail - label.length - age.length;
  if (slack() < MIN_INBOX_TEXT) label = "";
  if (slack() < MIN_INBOX_TEXT) age = "";
  const textW = Math.max(0, slack());
  const text = padEnd(fit(o.text, textW, g.ellipsis), textW);
  return {
    mark: o.mark,
    id,
    persona,
    label,
    text,
    age,
    total: 2 + id.length + persona.length + label.length + text.length + age.length,
  };
}

// ── Floor and needs-you headings ───────────────────────────────────────────

export interface HeadCells {
  /** Left half, in paint order; each is already clipped. */
  parts: string[];
  keys: KeyHint[];
  total: number;
}

function heading(parts: string[], keys: readonly KeyHint[], width: number, g: Glyphs): HeadCells {
  const clipped = clipSegments(parts, width, g.ellipsis);
  const used = clipped.reduce((n, s) => n + s.length, 0);
  // Two columns of gap between the headline and the hints, so they never
  // touch and never wrap.
  const kept = fitKeys(keys, Math.max(0, width - used - 2));
  return { parts: clipped, keys: kept, total: used + (kept.length > 0 ? 2 + keysWidth(kept) : 0) };
}

/** `FLOOR  n live · m need you · $x today` plus its key hints. */
export function layoutFloorHead(o: {
  live: number;
  needsYou: number;
  today: string;
  width: number;
  keys: readonly KeyHint[];
  glyphs?: Glyphs;
}): HeadCells {
  const g = o.glyphs ?? UNICODE;
  return heading(
    ["FLOOR", ` ${o.live} live · `, `${o.needsYou} need you`, ` · ${o.today} today`],
    o.keys,
    o.width,
    g,
  );
}

/** `NEEDS YOU n` plus its key hints. */
export function layoutInboxHead(o: {
  count: number;
  width: number;
  keys: readonly KeyHint[];
  glyphs?: Glyphs;
}): HeadCells {
  const g = o.glyphs ?? UNICODE;
  return heading(["NEEDS YOU", ` ${o.count}`], o.keys, o.width, g);
}

// ── Rail ───────────────────────────────────────────────────────────────────

/** How many roster rows fit. Header, its blank line and the cost footer are
 *  fixed; the last row is spent on the `+n more` tally when there is one. */
export function rosterWindow(count: number, height: number): { shown: number; more: number } {
  const budget = Math.max(0, Math.floor(height) - 3);
  const shown = count > budget ? Math.max(0, budget - 1) : count;
  return { shown, more: count - shown };
}

/** The width a compact row gets inside the rail: the cursor column and the
 *  rail's own left padding come off the top. */
export function rosterRowWidth(width: number): number {
  return Math.max(0, Math.floor(width) - 3);
}

// ── Palette ────────────────────────────────────────────────────────────────

export interface PaletteBox {
  /** Outer width, border included. */
  width: number;
  /** Usable columns inside the border and its padding. */
  inner: number;
  queryW: number;
  kindW: number;
  idW: number;
  labelW: number;
}

const PALETTE_MAX = 72;
const PALETTE_MIN = 24;

export function layoutPalette(width: number): PaletteBox {
  const w = Math.max(0, Math.floor(width));
  // The round border and paddingX each take a column on both sides.
  const outer = Math.min(Math.max(PALETTE_MIN, Math.min(PALETTE_MAX, w - 4)), w);
  const inner = Math.max(0, outer - 4);
  // Below thirty columns the kind ("run", "task", "plan") is the first thing
  // an operator can infer from the id, so it goes.
  const kindW = inner >= 30 ? 5 : 0;
  const idW = Math.max(0, Math.min(10, inner - kindW - MIN_INBOX_TEXT));
  return {
    width: outer,
    inner,
    queryW: Math.max(0, inner - 9),
    kindW,
    idW,
    labelW: Math.max(0, inner - kindW - idW),
  };
}

/** The overlay's own height: two border lines, the query line, the blank line
 *  under it, the rows, the blank line above the hints and the hints — plus the
 *  two blank lines the cockpit floats it above the status line with. */
export function paletteHeight(rows: number): number {
  return Math.max(0, Math.floor(rows)) + 8;
}

/** How many rows fit between the chat header and the status line. At 24 rows
 *  that is thirteen, and the palette's default of twenty would otherwise push
 *  the status line off the bottom. */
export function paletteRows(rows: number, wanted: number): number {
  return Math.max(1, Math.min(Math.max(0, Math.floor(wanted)), Math.floor(rows) - CHROME_H - 8));
}

export function layoutPaletteRow(
  item: { kind: string; id: string; label: string },
  box: PaletteBox,
  g: Glyphs = UNICODE,
): { kind: string; id: string; label: string; total: number } {
  const kind = padEnd(fit(item.kind, box.kindW, g.ellipsis), box.kindW);
  const id = padEnd(fit(item.id, box.idW, g.ellipsis), box.idW);
  const label = padEnd(fit(item.label, box.labelW, g.ellipsis), box.labelW);
  return { kind, id, label, total: kind.length + id.length + label.length };
}

// ── Composer ───────────────────────────────────────────────────────────────

/** `/cmd  one line of help`, clipped. The command column is fixed so the help
 *  texts line up; the help is what gives way. */
export function layoutHelp(
  cmds: readonly { cmd: string; help: string }[],
  width: number,
  g: Glyphs = UNICODE,
): { cmd: string; help: string }[] {
  // The two columns of indent the composer paints before the command.
  const avail = Math.max(0, Math.floor(width) - 2);
  return cmds.map((c) => {
    const cmd = fit(padEnd(c.cmd, 9), avail, g.ellipsis);
    return { cmd, help: fit(c.help, Math.max(0, avail - cmd.length), g.ellipsis) };
  });
}

/** `/model` suggestion rows: qualified model id first, display name after.
 *  The id column is shared (the widest on offer, capped) so the names line up
 *  the way `layoutHelp` lines its help texts up; the name gives way first. */
export function layoutCompletions(
  items: readonly { value: string; label: string }[],
  width: number,
  g: Glyphs = UNICODE,
): { value: string; label: string; total: number }[] {
  // The two columns of indent the composer paints before the list.
  const avail = Math.max(0, Math.floor(width) - 2);
  const longest = items.reduce((m, c) => Math.max(m, c.value.length), 0);
  const valueW = Math.min(MODEL_ID_W, avail, longest);
  return items.map((c) => {
    const value = padEnd(fit(c.value, valueW, g.ellipsis), valueW);
    const label = fit(c.label, Math.max(0, avail - valueW), g.ellipsis);
    return { value, label, total: value.length + label.length };
  });
}

/** Widest model id before the display name starts paying (`anthropic/claude-sonnet-4-6` fits). */
const MODEL_ID_W = 34;

/** The needs-you nudge above the prompt, as clipped segments. */
export function layoutPending(count: number, width: number, g: Glyphs = UNICODE): string[] {
  const said = count === 1 ? "an agent is waiting on you" : `${count} agents are waiting on you`;
  return clipSegments([`${g.flag} `, said, " · ", "tab", " to answer"], width, g.ellipsis);
}
