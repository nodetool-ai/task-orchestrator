// The animation, as arithmetic. Nothing here renders: the clock's job is to
// turn one number into a frame index and a highlight position, and both have
// to stay inside their bounds for every time a long session can reach.

import { describe, expect, it } from "vitest";
import { FRAME_MS, GLIMMER_MS, RUNWAY, glimmerAt, spinnerFrame } from "../../src/views/anim.js";
import { motionEnabled } from "../../src/views/motion.js";
import { UNICODE, ASCII } from "../../src/model/glyphs.js";

describe("spinnerFrame", () => {
  it("breathes: out along the list and back down it", () => {
    const frames = ["a", "b", "c"];
    const seen = Array.from({ length: 6 }, (_, i) => spinnerFrame(i * FRAME_MS, frames));
    expect(seen).toEqual(["a", "b", "c", "c", "b", "a"]);
    expect(spinnerFrame(6 * FRAME_MS, frames)).toBe("a");
  });

  it("holds a frame for its whole interval and never leaves the list", () => {
    for (const frames of [UNICODE.spinner, ASCII.spinner]) {
      expect(spinnerFrame(0, frames)).toBe(spinnerFrame(FRAME_MS - 1, frames));
      for (let t = 0; t < 200_000; t += 37) expect(frames).toContain(spinnerFrame(t, frames));
    }
  });

  it("answers something printable even with no frames to play", () => {
    expect(spinnerFrame(1000, [])).toBe(" ");
  });
});

describe("glimmerAt", () => {
  it("sweeps right to left, off the end of the word and back on", () => {
    const w = 10;
    const first = glimmerAt(0, w);
    const later = glimmerAt(GLIMMER_MS, w);
    expect(first).toBe(w + RUNWAY);
    expect(later).toBe(first - 1);
  });

  it("stays within a runway of the word, forever", () => {
    for (const w of [1, 10, 40]) {
      for (let t = 0; t < 200_000; t += 53) {
        const at = glimmerAt(t, w);
        expect(at).toBeLessThanOrEqual(w + RUNWAY);
        expect(at).toBeGreaterThan(-RUNWAY - 1);
      }
    }
  });
});

describe("motionEnabled", () => {
  it("moves only on a real terminal that asked for the full glyph set", () => {
    expect(motionEnabled({}, false, true)).toBe(true);
    expect(motionEnabled({}, true, true)).toBe(false); // --ascii: a plain console
    expect(motionEnabled({}, false, false)).toBe(false); // a pipe or a CI log
    expect(motionEnabled({ ORCH_NO_ANIM: "1" }, false, true)).toBe(false);
    expect(motionEnabled({ ORCH_NO_ANIM: "" }, false, true)).toBe(true);
  });
});
