// Single source of truth for classifying a run into a lifecycle bucket.
// Both the factory floor (lib/pi-floor-data.ts) and the live sidebar
// (app/api/live-sessions/route.ts) derive their groupings from classifyRun so
// the "completed run still showing as in review" rule lives in exactly one place.

export const ACTIVE_STATUSES = new Set(["preparing", "running", "pushing"]);
export const REVIEW_STATUSES = new Set(["opening_pr"]);
export const BLOCKED_STATUSES = new Set(["failed", "budget_exhausted"]);
export const SHIPPED_STATUSES = new Set(["completed"]);

export type RunCategory = "running" | "review" | "blocked" | "shipped";

/** Bucket as surfaced in the live sidebar — shipped runs are not "live". */
export type LiveBucket = Exclude<RunCategory, "shipped">;

/**
 * Classify a run, or return null when it doesn't belong to any bucket.
 *
 * A completed run that opened a PR is "review" only while its task is still
 * awaiting review. Once the task is done/cancelled (PR merged or closed) the run
 * is shipped, not live. Keying on prUrl alone misfiled every completed run as
 * review.
 */
export function classifyRun(
  status: string,
  prUrl: string | null,
  taskState: string | undefined
): RunCategory | null {
  if (ACTIVE_STATUSES.has(status)) return "running";
  if (REVIEW_STATUSES.has(status)) return "review";
  if (BLOCKED_STATUSES.has(status)) return "blocked";
  if (SHIPPED_STATUSES.has(status)) {
    if (prUrl && taskState === "review") return "review";
    return "shipped";
  }
  return null;
}

/** Live-sidebar bucket for a run, or null when it isn't a live session. */
export function bucketFor(
  status: string,
  prUrl: string | null,
  taskState: string | undefined
): LiveBucket | null {
  const cat = classifyRun(status, prUrl, taskState);
  return cat === "shipped" || cat === null ? null : cat;
}

/** Sidebar sort/priority: review shouts loudest, then blocked, then running. */
export const LIVE_BUCKET_PRIORITY: Record<LiveBucket, number> = {
  review: 0,
  blocked: 1,
  running: 2,
};

function beats(
  a: { bucket: LiveBucket; startedAt: number },
  b: { bucket: LiveBucket; startedAt: number }
): boolean {
  const pa = LIVE_BUCKET_PRIORITY[a.bucket];
  const pb = LIVE_BUCKET_PRIORITY[b.bucket];
  if (pa !== pb) return pa < pb; // higher priority (lower number) wins
  return a.startedAt > b.startedAt; // otherwise the newest run represents the task
}

/**
 * Collapse the live sidebar to one item per task. A task in `review` (or any
 * live bucket) typically has several runs behind it — an implement run, a review
 * run, follow-up fixes — and surfacing each as its own card floods the panel
 * with duplicates ("6 review cards for 2 tasks"). Keep a single representative
 * run per task: the highest-priority bucket, newest within that bucket. Items
 * without a taskId (none today, since the sidebar is task-scoped) pass through.
 */
export function dedupeLiveByTask<
  T extends { taskId: string | null; bucket: LiveBucket; startedAt: number },
>(items: readonly T[]): T[] {
  const best = new Map<string, T>();
  const noTask: T[] = [];
  for (const it of items) {
    if (it.taskId == null) {
      noTask.push(it);
      continue;
    }
    const cur = best.get(it.taskId);
    if (!cur || beats(it, cur)) best.set(it.taskId, it);
  }
  return [...best.values(), ...noTask];
}
