// lib/runner/environments.ts
//
// The environments registry: docker images, fly runner images, and box
// template snapshots as one concept (spec 2026-07-18-environments-design.md).
// Generalizes the former box-template-registry; resolveBoxTemplate keeps its
// contract and now filters provider='box'. The partial unique index on
// (provider, worker_sha) WHERE state IN ('building','ready') is the
// per-provider single-flight lock.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db";
import { environments } from "../../db/schema";
import { config } from "../config";
import { workerBuildSha } from "./worker-sha";

export type EnvironmentProvider = "docker" | "fly" | "box";
export type EnvironmentRow = typeof environments.$inferSelect;

export type TemplateResolution =
  | { kind: "pinned"; boxId: string }
  | { kind: "ready"; boxId: string; workerSha: string }
  | { kind: "building"; builderRunId: number | null; registryId: number; startedNow: boolean }
  | { kind: "cooldown"; registryId: number; error: string | null; retryAtMs: number };

export type TemplateBuildStarter = (row: {
  registryId: number;
  runId: number | null;
  workerSha: string;
}) => void;

let buildStarter: TemplateBuildStarter | null = null;
export function setTemplateBuildStarter(fn: TemplateBuildStarter | null): void {
  buildStarter = fn;
}

function orphanThresholdMs(): number {
  return 2 * 7 * config.box.buildStepTimeoutSeconds * 1000;
}

export async function resolveBoxTemplate(input: { runId: number }): Promise<TemplateResolution> {
  const pinned = config.box.templateId;
  if (pinned) return { kind: "pinned", boxId: pinned };

  const sha = await workerBuildSha();
  for (;;) {
    const [live] = await db
      .select()
      .from(environments)
      .where(and(
        eq(environments.provider, "box"),
        eq(environments.workerSha, sha),
        inArray(environments.state, ["building", "ready"])
      ));

    if (live?.state === "ready" && live.boxId) {
      return { kind: "ready", boxId: live.boxId, workerSha: sha };
    }
    if (live?.state === "building") {
      if (Date.now() - live.createdAt.getTime() > orphanThresholdMs()) {
        await db
          .update(environments)
          .set({ state: "failed", error: "Template build orphaned (server restarted mid-build)." })
          .where(and(eq(environments.id, live.id), eq(environments.state, "building")));
        continue;
      }
      return { kind: "building", builderRunId: live.triggeringRunId, registryId: live.id, startedNow: false };
    }

    const cooldownMs = config.box.buildRetryCooldownMs;
    if (cooldownMs > 0) {
      const [lastFailed] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.provider, "box"), eq(environments.workerSha, sha), eq(environments.state, "failed")))
        .orderBy(desc(environments.createdAt))
        .limit(1);
      if (lastFailed) {
        const retryAtMs = lastFailed.createdAt.getTime() + cooldownMs;
        if (Date.now() < retryAtMs) {
          return { kind: "cooldown", registryId: lastFailed.id, error: lastFailed.error, retryAtMs };
        }
      }
    }

    try {
      const [row] = await db
        .insert(environments)
        .values({ provider: "box", workerSha: sha, triggeringRunId: input.runId })
        .returning();
      if (buildStarter) buildStarter({ registryId: row.id, runId: input.runId, workerSha: sha });
      else console.warn(`environments ${row.id}: no build starter registered; row will orphan.`);
      return { kind: "building", builderRunId: input.runId, registryId: row.id, startedNow: true };
    } catch {
      continue; // unique-index race: another dispatch won; re-read
    }
  }
}

export async function markEnvironmentReady(
  id: number,
  artifact: { boxId?: string; image?: string }
): Promise<void> {
  const [row] = await db
    .update(environments)
    .set({ state: "ready", boxId: artifact.boxId ?? null, image: artifact.image ?? null, readyAt: new Date(), detail: null })
    .where(eq(environments.id, id))
    .returning();
  if (!row) return;
  // A newer environment supersedes older ready ones OF THE SAME PROVIDER; the
  // old artifacts (boxes/images) are left for retention/operators.
  await db
    .update(environments)
    .set({ state: "superseded" })
    .where(and(eq(environments.provider, row.provider), eq(environments.state, "ready"), ne(environments.id, id)));
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
 * Make configured docker/fly images visible as ready environments without a
 * build. Idempotent; never throws (the page must render even when the worker
 * SHA can't be resolved, e.g. no network for ls-remote).
 */
export async function registerConfiguredEnvironments(): Promise<void> {
  let sha: string;
  try {
    sha = await workerBuildSha();
  } catch {
    return;
  }
  const configured: Array<{ provider: EnvironmentProvider; image: string }> = [];
  if (config.deployment.workerImage) configured.push({ provider: "docker", image: config.deployment.workerImage });
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
