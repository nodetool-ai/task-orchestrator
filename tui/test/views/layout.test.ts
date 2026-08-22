import { describe, expect, it } from "vitest";
import { cursorWindow, layoutRow, tailWindow, wrapText, type RowInput } from "../../src/views/layout.js";

const base: RowInput = {
  prefix: "",
  id: 42,
  persona: "implementor",
  title: "wire the floor and the rail onto live overview data",
  pr: { number: 1234, ci: "unknown" },
  status: "running",
  age: "12m",
  cost: "$1.20",
  width: 80,
};

function render(c: ReturnType<typeof layoutRow>): string {
  // The glyph is one column the component paints, plus its trailing space.
  return `● ${c.prefix}${c.id}${c.persona}${c.title}${c.pr}${c.status}${c.age}${c.cost}`;
}

describe("layoutRow", () => {
  it("fills exactly the width it is given at 80 columns", () => {
    const c = layoutRow(base);
    expect(c.total).toBe(80);
    expect(render(c)).toHaveLength(80);
  });

  it("never exceeds the width, at any width, depth, or field length", () => {
    const prefixes = ["", "├ ", "│ ├ ", "│ │ └ ", "│ │ │ │ ├ ", "│ ".repeat(12)];
    const titles = ["", "x", "a readable title", "z".repeat(300), "T-0007 " + "long ".repeat(40)];
    const personas = ["", "qa", "implementor", "a-very-long-persona-name"];
    for (let width = 20; width <= 200; width++) {
      for (const prefix of prefixes) {
        for (const title of titles) {
          for (const persona of personas) {
            for (const compact of [false, true]) {
              for (const pr of [null, { number: 1234567, ci: "fail" as const }]) {
                const c = layoutRow({ ...base, prefix, title, persona, pr, width, compact, cost: "$1234.56" });
                expect(c.total).toBeLessThanOrEqual(width);
                expect(render(c).length).toBe(c.total);
              }
            }
          }
        }
      }
    }
  });

  it("gives up the cost before the status word, and the status word before the age", () => {
    // Squeeze the row by nesting it deeper and deeper at a fixed 80 columns.
    const seen: string[] = [];
    for (let depth = 0; depth <= 14; depth++) {
      const c = layoutRow({ ...base, prefix: "│ ".repeat(depth), width: 80 });
      seen.push(`${c.cost ? "c" : "-"}${c.status ? "s" : "-"}${c.age ? "a" : "-"}${c.pr ? "p" : "-"}`);
    }
    // Monotone: a column, once dropped, never comes back, and they go in order.
    expect(seen[0]).toBe("csap");
    const order = ["csap", "-sap", "--ap", "---p", "----"];
    let i = 0;
    for (const s of seen) {
      if (s !== order[i]) i++;
      expect(s).toBe(order[i]);
    }
  });

  it("keeps every column at 80 columns for a top-level row", () => {
    const c = layoutRow({ ...base, prefix: "", width: 80 });
    expect(c.cost.trim()).toBe("$1.20");
    expect(c.status.trim()).toBe("running");
    expect(c.age.trim()).toBe("12m");
    expect(c.pr).toContain("PR#1234");
  });

  it("marks unknown CI neutrally, never as a pass or a fail", () => {
    const c = layoutRow({ ...base, pr: { number: 7, ci: "unknown" } });
    expect(c.pr).toBe(" PR#7 ·");
  });
});

describe("wrapText", () => {
  it("never emits a line wider than the width", () => {
    const s = "the orchestrator spawned three implementors and a reviewer supercalifragilisticexpialidocious\nsecond paragraph";
    for (let w = 1; w <= 40; w++) {
      for (const l of wrapText(s, w)) expect(l.length).toBeLessThanOrEqual(w);
    }
  });

  it("keeps every word", () => {
    const s = "one two three four five";
    expect(wrapText(s, 9).join(" ").split(/\s+/).filter(Boolean)).toEqual(s.split(" "));
  });
});

describe("tailWindow", () => {
  it("pins to the bottom at scrollBack 0", () => {
    expect(tailWindow(100, 10, 0)).toEqual({ start: 90, end: 100, pinned: true });
  });

  it("clamps paging past either end", () => {
    expect(tailWindow(100, 10, 1000)).toEqual({ start: 0, end: 10, pinned: false });
    expect(tailWindow(100, 10, -5)).toEqual({ start: 90, end: 100, pinned: true });
    expect(tailWindow(4, 10, 3)).toEqual({ start: 0, end: 4, pinned: true });
  });
});

describe("cursorWindow", () => {
  it("keeps the cursor inside the window", () => {
    for (const cursor of [0, 1, 25, 49]) {
      const { start, end } = cursorWindow(50, 10, cursor);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
      expect(end - start).toBe(10);
    }
  });

  it("shows everything when it fits", () => {
    expect(cursorWindow(3, 10, 2)).toEqual({ start: 0, end: 3 });
  });
});
