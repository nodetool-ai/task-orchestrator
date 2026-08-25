// The composer's rules, straight from the suite (src/model/composer.ts): word
// motions that match readline, erase that respects a mid-line cursor, and a
// recall history that never loses the half-typed line it interrupted.

import { describe, expect, it } from "vitest";
import {
  backspace,
  clear,
  commit,
  del,
  emptyComposer,
  emptyLine,
  insert,
  killWordBack,
  left,
  recallNext,
  recallPrev,
  right,
  toEnd,
  toStart,
  wordBack,
  wordForward,
} from "../../src/model/composer.js";

const line = (text: string, cur = text.length) => ({ text, cur });

describe("line editing", () => {
  it("inserts at the cursor and leaves the rest in place", () => {
    expect(insert(line("helo", 3), "l")).toEqual(line("hello", 4));
    expect(insert(emptyLine(), "abc")).toEqual(line("abc", 3));
    expect(insert(line("hi"), "")).toEqual(line("hi")); // a keystroke may be empty
  });

  it("erases backwards only when there is something behind", () => {
    expect(backspace(line("hello", 3))).toEqual(line("helo", 2));
    expect(backspace(line("hello", 0))).toEqual(line("hello", 0));
  });

  it("erases forwards only when there is something ahead", () => {
    expect(del(line("hello", 2))).toEqual(line("helo", 2));
    expect(del(line("hello"))).toEqual(line("hello"));
  });

  it("moves by one column and clamps at both ends", () => {
    const l = line("hello", 2);
    expect(right(left(l))).toEqual(l);
    expect(left(left(left(l)))).toEqual(line("hello", 0));
    expect(right(right(right(right(right(right(l))))))).toEqual(line("hello"));
  });

  it("jumps to the ends", () => {
    expect(toStart(toEnd(line("ab")))).toEqual(line("ab", 0));
  });

  it("walks words the way readline does", () => {
    // `one two| three` — over the space, then onto the start of `two`.
    expect(wordBack(line("one two three", 7))).toEqual(line("one two three", 4));
    expect(wordBack(line("one two", 7))).toEqual(line("one two", 4));
    expect(wordBack(line("  spaced", 8))).toEqual(line("  spaced", 2));
    expect(wordBack(line("word", 1))).toEqual(line("word", 0));
    expect(wordForward(line("one two", 0))).toEqual(line("one two", 3));
    expect(wordForward(line("one   two", 3))).toEqual(line("one   two", 9));
    expect(wordForward(line("word", 4))).toEqual(line("word", 4));
  });
});

describe("^w (kill word back)", () => {
  it("takes the spaces before the word with it", () => {
    expect(killWordBack(line("one two ", 8))).toEqual(line("one ", 4));
    expect(killWordBack(line("/new implementor goal", 17))).toEqual(line("/new goal", 5));
  });

  it("is a no-op on an empty line or at column zero", () => {
    expect(killWordBack(line("", 0))).toEqual(line("", 0));
    expect(killWordBack(line("word", 0))).toEqual(line("word", 0));
  });
});

describe("recall history", () => {
  it("keeps what was sent, newest last, without consecutive repeats", () => {
    let c = emptyComposer();
    c = commit(c, "first");
    c = commit(c, "second");
    c = commit(c, "second"); // ↵ on an unchanged line adds nothing
    c = commit(c, ""); // blank lines were never sent
    expect(c.hist).toEqual(["first", "second"]);
    expect(c.line).toEqual(emptyLine());
  });

  it("recalls newest first and walks back one entry per press", () => {
    let c = emptyComposer();
    c = commit(c, "one");
    c = commit(c, "two");
    c = recallPrev(c);
    expect(c.line.text).toBe("two");
    c = recallPrev(c);
    expect(c.line.text).toBe("one");
    expect(c.histIx).toBe(0);
    c = recallPrev(c); // the oldest is the floor
    expect(c.line.text).toBe("one");
  });

  it("saves the half-typed draft on ↑ and hands it back past the newest entry", () => {
    let c = emptyComposer();
    c = commit(c, "sent");
    c = { ...c, line: line("half-typed dr", 13) };
    c = recallPrev(c);
    expect(c.line.text).toBe("sent");
    expect(c.draft).toBe("half-typed dr");
    c = commit(c, c.line.text); // send the recalled entry like any other
    c = { ...c, line: line("", 0) };
    c = recallPrev(c);
    expect(c.line.text).toBe("sent");
    c = recallNext(c); // past the newest entry…
    expect(c.line.text).toBe(""); // …rests on the empty live line, not the old draft
    c = commit(c, "x");
    c = { ...c, line: line("draft again") };
    c = recallPrev(c);
    c = recallNext(c);
    expect(c.line.text).toBe("draft again"); // ↓ restores exactly what ↑ saved
  });

  it("does nothing on an empty history or below the newest entry", () => {
    const fresh = emptyComposer();
    expect(recallPrev(fresh)).toBe(fresh);
    expect(recallNext(fresh)).toBe(fresh);
  });

  it("clear keeps the history; every edit lands the cursor sanely", () => {
    let c = emptyComposer();
    c = commit(c, "kept");
    c = { ...c, line: line("typo") };
    c = clear(c);
    expect(c.line).toEqual(emptyLine());
    expect(c.hist).toEqual(["kept"]);
    expect(recallPrev(c).line.text).toBe("kept");
  });
});
