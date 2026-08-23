import { describe, expect, it } from "vitest";
import { age, ageMinutes, duration, usd } from "../../src/model/time.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const minutesAgo = (m: number) => NOW - m * 60_000;

describe("age", () => {
  it.each([
    [0, "now"],
    [0.5, "now"],
    [1, "1m"],
    [12, "12m"],
    [59, "59m"],
    [60, "1h"],
    [180, "3h"],
    [1439, "24h"],
    [1440, "1d"],
    [2880, "2d"],
  ])("%i minutes → %s", (min, expected) => {
    expect(age(minutesAgo(min), NOW)).toBe(expected);
  });

  it("clamps a clock that runs backwards", () => {
    expect(ageMinutes(NOW + 60_000, NOW)).toBe(0);
    expect(age(NOW + 60_000, NOW)).toBe("now");
  });
});

describe("usd", () => {
  it("always shows two decimals", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(1.2)).toBe("$1.20");
    expect(usd(2.055)).toBe("$2.06");
    // toFixed, warts and all — the point is that nothing shifts visually.
    expect(usd(2.045)).toBe("$2.04");
  });
});

describe("duration", () => {
  it("counts a turn in seconds, then minutes, then hours", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(999)).toBe("0s");
    expect(duration(12_000)).toBe("12s");
    expect(duration(59_999)).toBe("59s");
    expect(duration(63_000)).toBe("1m 3s");
    expect(duration(3_599_000)).toBe("59m 59s");
    expect(duration(3_840_000)).toBe("1h 4m");
  });

  it("never counts backwards, whatever the clocks disagree about", () => {
    expect(duration(-5_000)).toBe("0s");
  });
});
