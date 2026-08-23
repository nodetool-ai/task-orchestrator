// The transcript's grammar, which is Claude Code's: `❯` for your turns, the
// filled dot for an agent turn and for a tool call, `∴` for a thinking block
// collapsed behind `^o`, and one `⎿` for whatever the call came back with.
//
// screen.test.ts already proves no line is wider than its pane; this proves
// the lines say what they are meant to say.

import { describe, expect, it } from "vitest";
import { C } from "../../src/model/colors.js";
import { buildForest } from "../../src/model/forest.js";
import type { Frame } from "../../src/model/frames.js";
import { UNICODE } from "../../src/model/glyphs.js";
import { runIndexRows } from "../../src/data.js";
import { frameLines, transcriptLines, type FrameCtx, type TSpanLine } from "../../src/views/transcript.js";

const forest = buildForest(runIndexRows);
const ctx = (over: Partial<FrameCtx> = {}): FrameCtx => ({
  forest,
  width: 80,
  trace: false,
  selfId: 42,
  g: UNICODE,
  ...over,
});

/** The painted line, spans glued back together. */
function flat(l: TSpanLine | { spans?: undefined }): string {
  return l.spans === undefined ? "" : l.spans.map((s) => s.text).join("");
}

function drawn(f: Frame, over: Partial<FrameCtx> = {}): string[] {
  return frameLines(f, 0, ctx(over))
    .map((l) => flat(l as TSpanLine))
    .filter((s) => s.trim() !== "");
}

describe("your turns", () => {
  it("open with the pointer, not a quote mark", () => {
    expect(drawn({ kind: "user", at: 0, text: "ship the CLI plan" })).toEqual(["❯ ship the CLI plan"]);
  });

  it("keep the addressing chip in front of the text", () => {
    expect(drawn({ kind: "user", at: 0, text: "pi", to: 45 })).toEqual(["❯ @#45 pi"]);
  });
});

describe("an agent turn", () => {
  const say: Frame = { kind: "agent", at: 0, run: 42, text: "Reading the plan." };

  it("opens with the dot and no byline when it is the run you are reading", () => {
    expect(drawn(say)).toEqual(["⏺ Reading the plan."]);
  });

  it("names anyone else, because the dot alone would not say who", () => {
    expect(drawn({ ...say, run: 44 })).toEqual(["⏺ implementor #44", "  Reading the plan."]);
  });
});

describe("a thinking block", () => {
  const think: Frame = { kind: "thinking", at: 0, run: 42, text: "One executor keeps the ordering in one place." };

  it("collapses to a single line that says how to open it", () => {
    expect(drawn(think)).toEqual(["∴ Thinking (^o to expand)"]);
  });

  it("shows the reasoning under ^o", () => {
    expect(drawn(think, { trace: true })).toEqual(["∴ Thinking…", "  One executor keeps the ordering in one place."]);
  });
});

describe("a tool call", () => {
  const call: Frame = {
    kind: "tool",
    at: 0,
    run: 42,
    text: "read cli.ts",
    name: "Read",
    arg: "cli.ts",
    detail: ["offset=40"],
    result: ["946 lines", "ok", "and more"],
    done: true,
  };

  it("is the name, its argument, and one line of what came back", () => {
    expect(drawn(call)).toEqual(["⏺ Read(cli.ts)", "  ⎿  946 lines", "     +2 lines (^o to expand)"]);
  });

  it("opens the whole result and the arguments under ^o", () => {
    expect(drawn(call, { trace: true })).toEqual([
      "⏺ Read(cli.ts)",
      "  ⎿  946 lines",
      "     ok",
      "     and more",
      "     offset=40",
    ]);
  });

  it("blinks its dot until the result lands, and never anything else", () => {
    const pending = frameLines({ ...call, result: [], done: false }, 0, ctx())[0] as TSpanLine;
    expect(pending.spans.filter((s) => s.blink === true).map((s) => s.text)).toEqual(["⏺ "]);
    // A blinking span still measures its own width, so the line under it
    // cannot move when the dot goes dark.
    expect(pending.spans[0]?.text).toHaveLength(2);
    const settled = frameLines(call, 0, ctx())[0] as TSpanLine;
    expect(settled.spans.some((s) => s.blink === true)).toBe(false);
  });

  it("settles a call the run never answered: dim when the run ended", () => {
    // #37 is completed. The result is never coming, so the dot stops pulsing
    // rather than promising work that is not happening.
    const stale = frameLines({ ...call, run: 37, result: [], done: false }, 0, ctx())[0] as TSpanLine;
    expect(stale.spans[0]?.blink).toBe(false);
    expect(stale.spans[0]?.color).toBe(C.muted);
  });

  it("settles it red when the run broke", () => {
    const broken = frameLines({ ...call, run: 36, result: [], done: false }, 0, ctx())[0] as TSpanLine;
    expect(broken.spans[0]?.blink).toBe(false);
    expect(broken.spans[0]?.color).toBe(C.blocked);
  });

  it("goes green when the result lands and red when the tool failed", () => {
    expect((frameLines(call, 0, ctx())[0] as TSpanLine).spans[0]?.color).toBe(C.done);
    const failed = frameLines({ ...call, error: true }, 0, ctx())[0] as TSpanLine;
    expect(failed.spans[0]?.color).toBe(C.blocked);
    expect(failed.spans[0]?.blink).toBe(false);
  });

  it("says nothing under a call that has not answered yet", () => {
    expect(drawn({ ...call, result: [], done: false })).toEqual(["⏺ Read(cli.ts)"]);
  });
});

describe("a spawn", () => {
  it("is a Task call with the children drawn live under it", () => {
    const lines = transcriptLines([{ kind: "spawn", at: 0, run: 42, children: [45] }], ctx());
    expect(flat(lines[0] as TSpanLine)).toBe("⏺ Task(implementor #45)");
    expect(lines[1]?.row?.run.id).toBe(45);
  });
});
