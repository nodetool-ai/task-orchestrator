// The other half of T-tui-13: the arithmetic in screen.test.ts says no region
// asks for more columns than it has, and this says Ink then paints what the
// arithmetic promised. It renders the whole cockpit against the mock
// fixtures — the same ones `npm run mock` uses — at 80×24, 100×30 and 160×50,
// and measures the frame Ink would have written to a terminal.
//
// No TTY is involved: Ink writes to whatever stream it is handed, so a fake
// one with `columns`/`rows` is a terminal as far as the renderer is concerned.
// JSX is out of reach here (the suite only picks up test/**/*.test.ts), which
// is why the elements are built by hand.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { App } from "../../src/app.js";
import { createFakeClient } from "../../src/data.js";

const SIZES: [cols: number, rows: number][] = [
  [80, 24],
  [100, 30],
  [160, 50],
];

/** Control sequences Ink emits around a frame; the frame itself is the text
 *  between them, and its width is what we are measuring. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

interface FakeOut extends EventEmitter {
  columns: number;
  rows: number;
  isTTY: boolean;
  write(chunk: string): boolean;
  frames: string[];
}

function fakeStdout(columns: number, rows: number): FakeOut {
  const out = new EventEmitter() as FakeOut;
  out.columns = columns;
  out.rows = rows;
  out.isTTY = true;
  out.frames = [];
  out.write = (chunk: string) => {
    out.frames.push(chunk);
    return true;
  };
  return out;
}

/** A real stream, not a stub: Ink drives input off `readable` + `read()`, so
 *  a bare EventEmitter would swallow every keystroke silently. */
function fakeStdin(): PassThrough & { isTTY: boolean; setRawMode(on: boolean): void } {
  const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(on: boolean): void };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  // Ink refs the handle so the process cannot exit while it is listening; a
  // PassThrough has no handle to ref.
  Object.assign(stdin, { ref: () => stdin, unref: () => stdin });
  return stdin;
}

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The last frame with content in it: Ink writes cursor and screen-mode
 *  escapes on their own, and those are not lines. */
function lastFrame(out: FakeOut): string {
  for (let i = out.frames.length - 1; i >= 0; i--) {
    const text = (out.frames[i] ?? "").replace(ANSI, "");
    if (text.trim() !== "") return text;
  }
  return "";
}

/** Poll rather than sleep: the frame we want is the one that has arrived,
 *  and how long that takes is the runner's business, not the test's. */
async function until(ready: () => boolean, ms = 5000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 20) {
    if (ready()) return;
    await tick(20);
  }
}

async function screenshot(
  cols: number,
  rows: number,
  keys: string[],
  marker: string,
  ascii = false,
): Promise<string[]> {
  const stdout = fakeStdout(cols, rows);
  const stdin = fakeStdin();
  const app = render(
    React.createElement(App, { client: createFakeClient(), initial: 42, baseUrl: "http://localhost:3000", ascii }),
    // patchConsole off so a stray console.log cannot land in the frame we
    // are about to measure. `interactive` is forced rather than detected:
    // Ink asks is-in-ci, and under a CI runner it writes nothing until
    // unmount, so the whole harness would measure an empty string and every
    // assertion here would be vacuous — which is exactly what it did.
    {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
    },
  );
  // The store fills from the fake client on mount; the frames before that are
  // an empty cockpit and would prove nothing. Waiting on the content rather
  // than on a fixed delay keeps a loaded CI runner from failing a screen that
  // was merely slow to arrive.
  await until(() => lastFrame(stdout).trim() !== "");
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
  await until(() => lastFrame(stdout).includes(marker));
  const frame = lastFrame(stdout);
  app.unmount();
  await tick(10);
  return frame.replace(/\n+$/, "").split("\n");
}

// ^f floor, ^n needs you, ^k jump, and the composer with a slash typed into
// it — the four states with something other than the transcript on screen.
const VIEWS: [name: string, keys: string[], marker: string][] = [
  ["chat", [], "asks"],
  ["floor", ["\x06"], "FLOOR"],
  ["needs you", ["\x0e"], "NEEDS YOU"],
  ["jump", ["\x0b"], "jump to"],
  ["composer help", ["/"], "/budget"],
];

describe("the rendered cockpit", () => {
  for (const [cols, rows] of SIZES) {
    for (const [view, keys, marker] of VIEWS) {
      it(`fits ${cols}x${rows} in ${view}`, async () => {
        const lines = await screenshot(cols, rows, keys, marker);
        // Without this the test would happily measure a cockpit that never
        // got the keystroke and stayed on the transcript.
        expect(lines.join("\n"), `${view} ${cols}x${rows}`).toContain(marker);
        for (const [i, line] of lines.entries()) {
          expect([...line].length, `${view} ${cols}x${rows} line ${i}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
            cols,
          );
        }
        expect(lines.length, `${view} ${cols}x${rows} rows`).toBeLessThanOrEqual(rows);
      });
    }
  }

  // --ascii swaps every mark for a one-column fallback, so the arithmetic is
  // the same — but only if every fallback really is one column.
  for (const [view, keys, marker] of VIEWS) {
    it(`fits 80x24 in ${view} under --ascii`, async () => {
      const lines = await screenshot(80, 24, keys, marker, true);
      expect(lines.join("\n")).toContain(marker);
      // Box drawing and block elements are what a font without them turns
      // into mojibake; the interpunct the prose separates with is not part of
      // the swap (T-tui-12) and is left alone here too.
      expect(lines.join("")).not.toMatch(/[\u2500-\u259f]/);
      for (const [i, line] of lines.entries()) {
        expect([...line].length, `${view} ascii line ${i}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(80);
      }
      expect(lines.length).toBeLessThanOrEqual(24);
    });
  }
});
