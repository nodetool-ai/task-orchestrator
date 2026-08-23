// What the non-interactive verbs print. Two renderings of the same rows:
// `--json` for programs (one document, arrays for lists, no ANSI) and plain
// text for eyes — one line per row, no box drawing, no colour, so `grep`,
// `awk` and a scrollback buffer all behave.
//
// The frame lines deliberately reuse model/frames.ts: `orch tail` must show a
// tool call exactly as the cockpit's `⎿` line does, and a second formatter
// would drift from it the first time a tool is renamed.

import { flatten, floorGroups, type Forest, type TreeRow } from "../model/forest.js";
import type { Frame } from "../model/frames.js";
import type { InboxItem } from "../model/inbox.js";
import { UNICODE, type Glyphs } from "../model/glyphs.js";
import type { Run } from "../model/run.js";
import { statusWord } from "../model/status.js";
import { age, usd } from "../model/time.js";

/** One floor row: the run plus its depth in the tree. */
export interface FloorRow {
  run: Run;
  depth: number;
}

/** Live subtrees first, then earlier ones — the same order the floor view
 *  paints, so `orch floor` and `^f` never disagree about what is on top. */
export function floorRows(forest: Forest): FloorRow[] {
  const { live, rest } = floorGroups(forest);
  return [...live, ...rest].map((r: TreeRow) => ({ run: r.run, depth: r.depth }));
}

/** Every run, ignoring the live/earlier split — used by nothing yet, but the
 *  flatten it wraps is the one guarantee callers care about (children under
 *  parents), so it stays next to floorRows. */
export function treeRows(forest: Forest): FloorRow[] {
  return flatten(forest).map((r) => ({ run: r.run, depth: r.depth }));
}

export function floorJson(rows: readonly FloorRow[]): unknown[] {
  return rows.map(({ run, depth }) => ({
    id: run.id,
    parentId: run.parentId,
    depth,
    persona: run.persona,
    title: run.title,
    status: run.status,
    taskId: run.taskId,
    planId: run.planId,
    pr: run.pr?.number ?? null,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    costUsd: run.cost,
    pendingEvents: run.pendingEvents,
    error: run.error,
  }));
}

export function floorText(rows: readonly FloorRow[], now: number): string[] {
  return rows.map(({ run, depth }) =>
    [
      padEnd(`#${run.id}`, 5),
      padEnd(statusWord(run.status), 9),
      padEnd(run.persona, 14),
      padStart(age(run.startedAt, now), 4),
      padStart(usd(run.cost), 8),
      // Indent rather than `├`/`└`: the tree is still legible after a pipe
      // through `cut`, and box drawing is not this surface's business.
      `${"  ".repeat(depth)}${run.title}`,
    ].join(" "),
  );
}

export function inboxJson(items: readonly InboxItem[]): unknown[] {
  return items.map((it) => ({
    id: it.id,
    runId: it.runId,
    persona: it.persona,
    kind: it.kind,
    text: it.text,
    at: it.at,
    prUrl: it.prUrl,
  }));
}

export function inboxText(items: readonly InboxItem[], now: number): string[] {
  return items.map((it) =>
    [padEnd(`#${it.runId}`, 5), padEnd(it.kind, 8), padEnd(it.persona, 14), padStart(age(it.at, now), 4), it.text].join(
      " ",
    ),
  );
}

/** How a frame names the agent that produced it. `self` is the run being
 *  tailed, so its own turns read as the persona and a child's read as `#id`. */
export interface Speaker {
  self: number;
  persona: string;
}

/**
 * One frame, one line. The shapes mirror views/chat.tsx with the colour and
 * the wrapping taken out: `>` for your turns, `∴` for a thinking block, `⎿`
 * for a tool call, `·` for an event, `⚑` for a question.
 */
export function frameLine(f: Frame, who: Speaker, g: Glyphs = UNICODE): string {
  switch (f.kind) {
    case "user":
      return `> ${oneLine(f.text)}`;
    case "agent":
      return `${speaker(f.run, who)}: ${oneLine(f.text)}`;
    case "thinking":
      return `  ${g.think} ${oneLine(f.text)}`;
    case "tool":
      return `  ${g.tool} ${f.text}`;
    case "spawn":
      return `  ${g.tool} spawned ${f.children.length === 0 ? "an agent" : f.children.map((c) => `#${c}`).join(" ")}`;
    case "event":
      return `  ${g.bullet} ${oneLine(f.text)}`;
    case "question":
      return f.answered === undefined
        ? `${g.flag} ${speaker(f.run, who)} asks: ${oneLine(f.text)}`
        : `${g.flag} ${speaker(f.run, who)} asks: ${oneLine(f.text)} ${g.answer} you: ${oneLine(f.answered)}`;
  }
}

/** The same frame as data. `kind` is the discriminator the text form encodes
 *  in its glyph, so a `--json` consumer never has to parse the line. */
export function frameJson(f: Frame, who: Speaker): unknown {
  const run = f.kind === "user" ? who.self : f.run;
  return { ...f, run, persona: run === who.self ? who.persona : null };
}

function speaker(run: number, who: Speaker): string {
  return run === who.self ? who.persona : `#${run}`;
}

// ── small helpers ─────────────────────────────────────────────────────────
// Local rather than from theme.tsx: that module imports Ink, and a list verb
// must not load a renderer.

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function padEnd(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}
