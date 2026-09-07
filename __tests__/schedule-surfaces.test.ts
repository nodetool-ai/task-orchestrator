import { describe, expect, it } from "vitest";
import { scheduleApiInputSchema, scheduleApiPatchSchema } from "../lib/validators";
import { formatScheduleShow, parseScheduleDate, parseScheduleKind } from "../lib/schedule-cli";
import * as schedules from "../lib/schedules";

describe("schedule API wire contracts", () => {
  it("parses CLI trigger flags into service values", () => {
    expect(parseScheduleKind("cron")).toBe("cron");
    expect(parseScheduleDate("2026-09-08T02:00:00Z", "run-at")?.toISOString()).toBe("2026-09-08T02:00:00.000Z");
    expect(() => parseScheduleKind("daily")).toThrow(/Expected/);
    expect(() => parseScheduleDate("invalid", "run-at")).toThrow(/run-at/);
  });
  it("coerces ISO trigger dates for the shared service", () => {
    const parsed = scheduleApiInputSchema.parse({
      name: "Nightly pass", prompt: "Review the repository", repoId: "R-default", kind: "once",
      runAt: "2026-09-08T02:00:00.000Z", timezone: "UTC",
    });
    expect(parsed.runAt).toBeInstanceOf(Date);
    expect(parsed.runAt?.toISOString()).toBe("2026-09-08T02:00:00.000Z");
  });

  it("keeps explicit null overrides available to PATCH callers", () => {
    const parsed = scheduleApiPatchSchema.parse({ personaId: null, model: null, toolsProfile: null, runAt: null });
    expect(parsed).toEqual({ personaId: null, model: null, toolsProfile: null, runAt: null });
  });

  it("renders schedule show details with actual newlines", () => {
    const output = formatScheduleShow("#7 enabled Nightly", "Review the repository", "UTC");
    expect(output).toContain("#7 enabled Nightly\n  prompt: Review the repository\n  timezone: UTC");
    expect(output).not.toContain("\\n");
  });

  it("rejects non-positive budgets and malformed trigger dates", () => {
    expect(() => scheduleApiInputSchema.parse({ name: "x", prompt: "y", repoId: "R-default", kind: "interval", intervalSeconds: 0 })).toThrow();
    expect(() => scheduleApiInputSchema.parse({ name: "x", prompt: "y", repoId: "R-default", kind: "once", runAt: "not-a-date" })).toThrow();
  });
});
