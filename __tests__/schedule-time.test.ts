import { describe, expect, it } from "vitest";
import { firstOccurrenceAt, instantToWallClock, schedulePreview, wallClockToInstant } from "../lib/schedule-time";

describe("schedule time helpers", () => {
  const now = new Date("2026-03-07T15:00:00.000Z");

  it("calculates the exact cron next instant in the selected IANA zone", () => {
    const result = schedulePreview({ kind: "cron", cronExpression: "0 9 * * *", timezone: "America/New_York", now });
    expect(result.nextAt?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("round-trips an instant through a selected zone without drift", () => {
    const instant = new Date("2026-07-01T13:30:00.000Z");
    const wall = instantToWallClock(instant, "America/New_York");
    expect(wall).toBe("2026-07-01T09:30");
    expect(wallClockToInstant(wall, "America/New_York").toISOString()).toBe(instant.toISOString());
  });

  it("rejects nonexistent and ambiguous local times", () => {
    expect(() => wallClockToInstant("2026-03-08T02:30", "America/New_York")).toThrow(/does not exist/);
    expect(() => wallClockToInstant("2026-11-01T01:30", "America/New_York")).toThrow(/ambiguous/);
  });

  it("previews an empty interval as immediate, matching the saved first occurrence", () => {
    const result = schedulePreview({ kind: "interval", intervalSeconds: 3600, timezone: "UTC", now });
    expect(result.immediate).toBe(true);
    expect(result.nextAt?.toISOString()).toBe(now.toISOString());
    expect(firstOccurrenceAt("interval", now, null, 3600).toISOString()).toBe(now.toISOString());
  });

  it("surfaces invalid zones and cron expressions instead of throwing", () => {
    expect(schedulePreview({ kind: "cron", cronExpression: "0 9 * * *", timezone: "Mars/Bad", now }).error).toMatch(/Invalid IANA timezone/);
    expect(schedulePreview({ kind: "cron", cronExpression: "not cron", timezone: "UTC", now }).error).toBeTruthy();
  });
});
