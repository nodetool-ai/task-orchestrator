import { CronExpressionParser } from "cron-parser";
import { DateTime } from "luxon";

export type SchedulePreviewKind = "once" | "interval" | "cron";

export type SchedulePreview = {
  nextAt: Date | null;
  immediate?: boolean;
  error?: string;
};

/** Validate an IANA zone without allowing the runtime's local zone fallback. */
export function isValidTimeZone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  return DateTime.fromISO("2000-01-01T00:00", { zone: timezone, setZone: true }).isValid;
}

function normalizedWallClock(value: string): string {
  // datetime-local emits minute precision. Accept seconds too for callers that
  // construct forms programmatically, while preserving the exact input fields.
  return value.length === 16 ? `${value}:00` : value;
}

/**
 * Convert a wall-clock form value in an IANA zone to an instant.
 * Luxon reports both gap normalization and ambiguous offsets, so neither can
 * be silently shifted into a different instant.
 */
export function wallClockToInstant(value: string, timezone: string): Date {
  if (!isValidTimeZone(timezone)) throw new Error(`Invalid IANA timezone: ${timezone || "(empty)"}`);
  const wall = normalizedWallClock(value);
  const parsed = DateTime.fromISO(wall, { zone: timezone, setZone: true });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new Error("This local time does not exist in the selected timezone");
  }
  if (parsed.getPossibleOffsets().length > 1) {
    throw new Error("This local time is ambiguous in the selected timezone; choose another time");
  }
  return parsed.toUTC().toJSDate();
}

/** Convert a stored instant back to a datetime-local value in its IANA zone. */
export function instantToWallClock(value: Date | string, timezone: string): string {
  if (!isValidTimeZone(timezone)) throw new Error(`Invalid IANA timezone: ${timezone || "(empty)"}`);
  const parsed = DateTime.fromJSDate(typeof value === "string" ? new Date(value) : value, { zone: timezone });
  if (!parsed.isValid) throw new Error("Invalid schedule instant");
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm");
}

export function nextCronInstant(cronExpression: string, timezone: string, after: Date): Date {
  if (!isValidTimeZone(timezone)) throw new Error(`Invalid IANA timezone: ${timezone || "(empty)"}`);
  return CronExpressionParser.parse(cronExpression, { tz: timezone, currentDate: after }).next().toDate();
}

/** The scheduler's first interval occurrence rule: no start means immediate. */
export function firstOccurrenceAt(kind: SchedulePreviewKind, now: Date, startAt?: Date | null, _intervalSeconds?: number | null): Date {
  if (kind === "once") {
    if (!startAt) throw new Error("One-time schedules require a run time");
    return startAt;
  }
  if (kind === "interval") return startAt ?? now;
  throw new Error("Cron schedules require an expression");
}

/** Pure preview calculation shared by the editor and schedule cadence tests. */
export function schedulePreview(input: {
  kind: SchedulePreviewKind;
  timezone?: string;
  now: Date;
  runAt?: string | Date | null;
  startAt?: string | Date | null;
  intervalSeconds?: number | null;
  cronExpression?: string | null;
}): SchedulePreview {
  try {
    const timezone = input.timezone || "UTC";
    if (!isValidTimeZone(timezone)) return { nextAt: null, error: `Invalid IANA timezone: ${timezone || "(empty)"}` };
    if (input.kind === "cron") {
      if (!input.cronExpression?.trim()) return { nextAt: null, error: "Enter a five-field cron expression" };
      return { nextAt: nextCronInstant(input.cronExpression, timezone, input.now) };
    }
    if (input.kind === "once") {
      if (!input.runAt) return { nextAt: null, error: "Choose a date and time" };
      const instant = input.runAt instanceof Date ? input.runAt : wallClockToInstant(input.runAt, timezone);
      return { nextAt: instant };
    }
    if (!input.intervalSeconds || !Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0) {
      return { nextAt: null, error: "Choose a positive interval" };
    }
    if (!input.startAt) return { nextAt: input.now, immediate: true };
    const instant = input.startAt instanceof Date ? input.startAt : wallClockToInstant(input.startAt, timezone);
    return { nextAt: instant };
  } catch (error) {
    return { nextAt: null, error: error instanceof Error ? error.message : "Invalid schedule time" };
  }
}
