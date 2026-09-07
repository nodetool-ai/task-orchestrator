import type { ScheduleKind } from "./schedules";

/** Parse the CLI's ISO date flags before handing a typed Date to the service. */
export function parseScheduleDate(raw: string | undefined, flag = "date"): Date | undefined {
  if (raw === undefined || raw === "") return undefined;
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid --${flag}: ${raw}`);
  return date;
}

export function parseScheduleKind(raw: string | undefined): ScheduleKind {
  if (raw === "once" || raw === "interval" || raw === "cron") return raw;
  throw new Error(`Invalid --kind: ${raw ?? ""}. Expected once, interval, or cron.`);
}

/** Human-readable detail output keeps prompt fields on their own actual lines. */
export function formatScheduleShow(summary: string, prompt: string, timezone: string): string {
  return `${summary}\n  prompt: ${prompt}\n  timezone: ${timezone}`;
}
