// The composer's text engine. Two jobs: a cursor over one line of input
// (arrows, home/end, word motions, positional backspace), and a recall
// history for the lines already sent. No Ink here, so every key an operator
// can feel is asserted straight from the suite (test/model/composer.test.ts);
// views/prompt.tsx paints what this returns and app.tsx maps keys onto it.

export interface Line {
  /** The whole input, control characters excluded by construction. */
  text: string;
  /** Where the next keystroke lands, as an index into `text`. */
  cur: number;
}

/** An empty line, cursor at the start. */
export function emptyLine(): Line {
  return { text: "", cur: 0 };
}

/** Typed characters (a keystroke or a paste) land at the cursor, which moves
 *  after them — the behaviour every editor shares. */
export function insert(l: Line, s: string): Line {
  if (!s) return l;
  return { text: l.text.slice(0, l.cur) + s + l.text.slice(l.cur), cur: l.cur + s.length };
}

/** Delete the character before the cursor; at column zero it is a no-op. */
export function backspace(l: Line): Line {
  if (l.cur === 0) return l;
  return { text: l.text.slice(0, l.cur - 1) + l.text.slice(l.cur), cur: l.cur - 1 };
}

/** Delete the character at the cursor; at end-of-line it is a no-op. */
export function del(l: Line): Line {
  if (l.cur >= l.text.length) return l;
  return { text: l.text.slice(0, l.cur) + l.text.slice(l.cur + 1), cur: l.cur };
}

export function left(l: Line): Line {
  return { ...l, cur: Math.max(0, l.cur - 1) };
}

export function right(l: Line): Line {
  return { ...l, cur: Math.min(l.text.length, l.cur + 1) };
}

export function toStart(l: Line): Line {
  return { ...l, cur: 0 };
}

export function toEnd(l: Line): Line {
  return { ...l, cur: l.text.length };
}

const WORD = /\S/;

/** Readline's ⌥b: over any spaces, then to the start of the word. */
export function wordBack(l: Line): Line {
  let i = l.cur;
  while (i > 0 && !WORD.test(l.text[i - 1]!)) i--;
  while (i > 0 && WORD.test(l.text[i - 1]!)) i--;
  return { ...l, cur: i };
}

/** Readline's ⌥f: over any spaces, then to the end of the word. */
export function wordForward(l: Line): Line {
  let i = l.cur;
  while (i < l.text.length && !WORD.test(l.text[i]!)) i++;
  while (i < l.text.length && WORD.test(l.text[i]!)) i++;
  return { ...l, cur: i };
}

/** Readline's ^w: kill the word before the cursor, its leading spaces with
 *  it — so `one two^w` leaves `one `, ready for the replacement word. */
export function killWordBack(l: Line): Line {
  const w = wordBack(l);
  return { text: w.text.slice(0, w.cur) + l.text.slice(l.cur), cur: w.cur };
}

// ── recall history ───────────────────────────────────────────────────────────

/**
 * The composer plus everything it remembers. `histIx === hist.length` means
 * the live draft is on the line; anything less is an entry being revisited.
 * `draft` holds the half-typed line while an entry is up, so walking down
 * past the newest entry hands the typing back exactly as it was left.
 */
export interface Composer {
  line: Line;
  hist: string[];
  histIx: number;
  draft: string;
}

export function emptyComposer(): Composer {
  return { line: emptyLine(), hist: [], histIx: 0, draft: "" };
}

function withLine(c: Composer, l: Line): Composer {
  return { ...c, line: l };
}

// One edit per keystroke, each taking and returning a whole Composer so the
// history bookkeeping can never drift out of step with the line on screen.
export type Edit = (c: Composer) => Composer;

export const insertText =
  (s: string): Edit =>
  (c) =>
    withLine(c, insert(c.line, s));

export const erase: Edit = (c) => withLine(c, backspace(c.line));

export const eraseForward: Edit = (c) => withLine(c, del(c.line));

export const cursorLeft: Edit = (c) => withLine(c, left(c.line));

export const cursorRight: Edit = (c) => withLine(c, right(c.line));

export const cursorWordBack: Edit = (c) => withLine(c, wordBack(c.line));

export const cursorWordForward: Edit = (c) => withLine(c, wordForward(c.line));

export const killWord: Edit = (c) => withLine(c, killWordBack(c.line));

export const cursorHome: Edit = (c) => withLine(c, toStart(c.line));

export const cursorEnd: Edit = (c) => withLine(c, toEnd(c.line));

/** Swap the whole line for `s` — tab completion's move. Cursor at the end,
 *  where the next keystroke or ↵ expects it. */
export const replaced =
  (s: string): Edit =>
  (c) =>
    withLine(c, { text: s, cur: s.length });

/** A sent line joins the top of the history — unless it repeats the one
 *  before it, which would only make ↑ more expensive. Blank lines are not
 *  history: they never reached anyone. */
export function commit(c: Composer, raw: string): Composer {
  const text = raw.trim();
  if (!text) return { ...c, line: emptyLine(), histIx: c.hist.length, draft: "" };
  const hist = c.hist[c.hist.length - 1] === text ? c.hist : [...c.hist, text];
  return { line: emptyLine(), hist, histIx: hist.length, draft: "" };
}

/** `esc`: the line goes, but the history stays. */
export function clear(c: Composer): Composer {
  return { ...c, line: emptyLine(), histIx: c.hist.length, draft: "" };
}

/** ↑: the previous entry, or nothing at all without one. Leaving the live
 *  draft saves it first; the cursor lands at the end, where ↵ works. */
export function recallPrev(c: Composer): Composer {
  if (c.hist.length === 0 || c.histIx === 0) return c;
  const ix = c.histIx === c.hist.length ? c.hist.length - 1 : c.histIx - 1;
  const draft = c.histIx === c.hist.length ? c.line.text : c.draft;
  return { ...c, line: { text: c.hist[ix]!, cur: c.hist[ix]!.length }, histIx: ix, draft };
}

/** ↓: forward through the entries, then the saved draft, then it rests. */
export function recallNext(c: Composer): Composer {
  if (c.histIx >= c.hist.length) return c;
  const ix = c.histIx + 1;
  if (ix === c.hist.length) return { ...c, line: { text: c.draft, cur: c.draft.length }, histIx: ix };
  return { ...c, line: { text: c.hist[ix]!, cur: c.hist[ix]!.length }, histIx: ix };
}
