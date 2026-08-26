// lib/runner/environments.ts
//
// The environments registry: docker images and fly runner images as one
// concept (spec 2026-07-18-environments-design.md), one row per build,
// versioned by worker SHA. The partial unique index on (provider, worker_sha)
// WHERE state IN ('building','ready') is the per-provider single-flight lock.
import { and, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { db } from "../../db";
import { environments } from "../../db/schema";
import { workerBuildSha } from "./worker-sha";

export type EnvironmentProvider = "docker" | "fly";
export type EnvironmentRow = typeof environments.$inferSelect;

export async function markEnvironmentReady(
  id: number,
  artifact: { image?: string }
): Promise<void> {
  const [row] = await db
    .update(environments)
    .set({ state: "ready", image: artifact.image ?? null, readyAt: new Date(), detail: null })
    .where(eq(environments.id, id))
    .returning();
  if (!row) return;
  // Supersede is ordered by id (serial, monotonic with creation) so a build
  // that finishes LATE cannot clobber a newer one that already went ready.
  // Two moves, each idempotent, converge to "highest-id ready row wins"
  // regardless of the order two concurrent builds complete in:
  //   1. this row supersedes older ready rows of the same provider;
  //   2. if a NEWER ready row already exists, this row is stale on arrival and
  //      demotes ITSELF instead of standing as a second ready row.
  await db
    .update(environments)
    .set({ state: "superseded" })
    .where(and(eq(environments.provider, row.provider), eq(environments.state, "ready"), lt(environments.id, id)));
  const [newer] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.provider, row.provider), eq(environments.state, "ready"), gt(environments.id, id)))
    .limit(1);
  if (newer) {
    await db
      .update(environments)
      .set({ state: "superseded" })
      .where(and(eq(environments.id, id), eq(environments.state, "ready")));
  }
}

export async function markEnvironmentFailed(id: number, error: string): Promise<void> {
  await db.update(environments).set({ state: "failed", error, detail: null }).where(eq(environments.id, id));
}

export async function setEnvironmentDetail(id: number, detail: string): Promise<void> {
  await db.update(environments).set({ detail }).where(eq(environments.id, id));
}

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  return db.select().from(environments).orderBy(desc(environments.createdAt));
}

/**
 * Make externally-supplied images visible as ready environments without a
 * build. Idempotent; never throws (the page must render even when the worker
 * SHA can't be resolved, e.g. no network for ls-remote).
 *
 * Only fly qualifies: its image is built and pushed out-of-app, so a configured
 * `FLY_RUNNER_IMAGE` genuinely names a ready artifact. Docker is deliberately
 * excluded — `TASK_ORCH_WORKER_IMAGE` is the TARGET tag the in-app host build
 * writes to, not evidence an image already exists. Pre-marking it `ready` would
 * make the page's "Build image" button 409 forever (a live ready row blocks the
 * build), so docker becomes ready only after a real build completes. Dispatch
 * reads the env var directly and never gates on a ready row, so nothing else
 * depends on docker being pre-registered here.
 */
export async function registerConfiguredEnvironments(): Promise<void> {
  let sha: string;
  try {
    sha = await workerBuildSha();
  } catch {
    return;
  }
  const configured: Array<{ provider: EnvironmentProvider; image: string }> = [];
  const flyImage = process.env.FLY_RUNNER_IMAGE;
  if (flyImage) configured.push({ provider: "fly", image: flyImage });

  for (const { provider, image } of configured) {
    const [live] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.provider, provider), eq(environments.workerSha, sha), inArray(environments.state, ["building", "ready"])));
    if (live) {
      // Config changed the tag under the same SHA: reflect it.
      if (live.state === "ready" && live.image !== image) {
        await db.update(environments).set({ image }).where(eq(environments.id, live.id));
      }
      continue;
    }
    try {
      const [row] = await db
        .insert(environments)
        .values({ provider, workerSha: sha, state: "ready", image, readyAt: new Date() })
        .returning();
      if (row) {
        await db
          .update(environments)
          .set({ state: "superseded" })
          .where(and(eq(environments.provider, provider), eq(environments.state, "ready"), ne(environments.id, row.id)));
      }
    } catch {
      // unique race with a concurrent register/build — fine, someone owns it
    }
  }
}
