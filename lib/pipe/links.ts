// lib/pipe/links.ts
//
// Deep links for the messaging surfaces (PRD §8, "links, not dumps"): every
// entity a persona or the relay mentions by id — task, plan, run, PR — carries
// a link back to the web UI, which is the escape hatch to full fidelity.
//
// The base URL comes from TASK_ORCH_PUBLIC_URL (lib/config.ts). When it is
// unset the helpers emit a bare PATH (`/runs/214`) rather than a broken
// absolute URL: a path is still useful to anyone reading the thread next to
// the web app, and it is exactly what the pre-M5 `/whoami` reply already
// printed. No trailing-slash handling here — config normalises that.

import { config } from "@/lib/config";

/** Absolute URL for a web-UI path, or the bare path when no base is configured. */
export function webLink(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = config.publicUrl;
  return base ? `${base}${p}` : p;
}

export const runLink = (id: number): string => webLink(`/runs/${id}`);
/** The runs OVERVIEW — where "…and 3 more" goes (not the first item shown). */
export const runsLink = (): string => webLink("/runs");
export const taskLink = (id: string): string => webLink(`/tasks/${id}`);
export const planLink = (id: string): string => webLink(`/plans/${id}`);

/**
 * The one-line "what is this run" label used by both the relay's breadcrumbs
 * and the /status digest, so the two surfaces name the same run the same way.
 * Prefers the human title, falls back to the task id, then the goal.
 */
export function runLabel(run: {
  id: number;
  title: string | null;
  taskId: string | null;
  goal: string;
}): string {
  const raw = run.title?.trim() || run.taskId || (run.goal === "<chat>" ? "chat" : run.goal);
  const oneLine = raw.split("\n")[0].trim();
  return oneLine.length > 70 ? `${oneLine.slice(0, 69)}…` : oneLine;
}
