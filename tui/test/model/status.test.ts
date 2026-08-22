import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../../src/api/types.js";
import { isLive, statusWord, toTuiStatus, type TuiStatus } from "../../src/model/status.js";

// The whole projection, in one table: ten server statuses (and every park
// reason) onto the seven glyphs of PRD §6.2.
const TABLE: Array<[SessionStatus, string | null, TuiStatus]> = [
  ["running", null, "running"],
  ["preparing", null, "preparing"],
  ["pending", null, "queued"],
  ["idle", null, "idle"],
  ["completed", null, "done"],
  ["closed", null, "done"],
  ["failed", null, "failed"],
  ["cancelled", null, "failed"],
  ["budget_exhausted", null, "failed"],
  ["parked", "question", "parked"],
  ["parked", "waiting", "queued"],
  ["parked", "sleeping", "queued"],
  ["parked", null, "queued"],
];

describe("toTuiStatus", () => {
  it.each(TABLE)("%s (%s) → %s", (status, reason, expected) => {
    expect(toTuiStatus(status, reason)).toBe(expected);
  });

  it("covers every SessionStatus", () => {
    const seen = new Set(TABLE.map(([s]) => s));
    const all: SessionStatus[] = [
      "pending",
      "preparing",
      "running",
      "completed",
      "failed",
      "cancelled",
      "idle",
      "budget_exhausted",
      "closed",
      "parked",
    ];
    expect(all.filter((s) => !seen.has(s))).toEqual([]);
  });

  it("treats an unknown park reason as queued, not as needing a human", () => {
    expect(toTuiStatus("parked", "hibernating")).toBe("queued");
  });
});

describe("statusWord", () => {
  it("labels parked as the thing the human has to do", () => {
    expect(statusWord("parked")).toBe("asks you");
  });
  it("names the other six plainly", () => {
    expect(["running", "preparing", "queued", "idle", "done", "failed"].map((s) => statusWord(s as TuiStatus))).toEqual([
      "running",
      "preparing",
      "queued",
      "idle",
      "done",
      "failed",
    ]);
  });
});

describe("isLive", () => {
  it("is true for anything still on the floor", () => {
    expect(["running", "preparing", "queued", "parked"].map((s) => isLive(s as TuiStatus))).toEqual([true, true, true, true]);
  });
  it("is false for done, failed and idle chats", () => {
    expect(["done", "failed", "idle"].map((s) => isLive(s as TuiStatus))).toEqual([false, false, false]);
  });
});
