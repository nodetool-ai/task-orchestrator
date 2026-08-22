import { describe, expect, it } from "vitest";
import { age, ageMinutes, usd } from "../../src/model/time.js";

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
