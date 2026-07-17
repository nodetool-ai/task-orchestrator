// lib/runner/box-template-registry.ts
//
// App-managed Box template registry (spec 2026-07-17-box-app-managed-template).
// The partial unique index on box_templates(worker_sha) WHERE state IN
// ('building','ready') makes the INSERT below a single-flight lock: exactly
// one dispatch starts a build per worker SHA; the losers observe the winner's
// row and defer behind it.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { boxTemplates } from "../../db/schema";
import { config } from "../config";
import { workerBuildSha } from "./worker-sha";

export type TemplateResolution =
  | { kind: "pinned"; boxId: string }
  | { kind: "ready"; boxId: string; workerSha: string }
  | { kind: "building"; builderRunId: number | null; registryId: number; startedNow: boolean };

export type TemplateBuildStarter = (row: {
  registryId: number;
  runId: number;
  workerSha: string;
}) => void;

// Injected by the provider at construction; a module-level seam (not an
// import) so registry ⇄ builder stays cycle-free and tests can observe kicks.
let buildStarter: TemplateBuildStarter | null = null;
export function setTemplateBuildStarter(fn: TemplateBuildStarter | null): void {
  buildStarter = fn;
}

/** A building row older than 2× the whole-build budget was orphaned by a
 *  server restart (no heartbeat machinery in v1). */
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
      .from(boxTemplates)
      .where(and(eq(boxTemplates.workerSha, sha), inArray(boxTemplates.state, ["building", "ready"])));

    if (live?.state === "ready" && live.boxId) {
      return { kind: "ready", boxId: live.boxId, workerSha: sha };
    }
    if (live?.state === "building") {
      if (Date.now() - live.createdAt.getTime() > orphanThresholdMs()) {
        await db
          .update(boxTemplates)
          .set({ state: "failed", error: "Template build orphaned (server restarted mid-build)." })
          .where(and(eq(boxTemplates.id, live.id), eq(boxTemplates.state, "building")));
        continue; // re-read; either we insert fresh below or another racer did
      }
      return { kind: "building", builderRunId: live.triggeringRunId, registryId: live.id, startedNow: false };
    }

    // Miss (no live row, or only failed/superseded history): try to claim.
    try {
      const [row] = await db
        .insert(boxTemplates)
        .values({ workerSha: sha, repository: config.box.agentRepo, triggeringRunId: input.runId })
        .returning();
      if (buildStarter) buildStarter({ registryId: row.id, runId: input.runId, workerSha: sha });
      else console.warn(`box_templates ${row.id}: no build starter registered; row will orphan.`);
      return { kind: "building", builderRunId: input.runId, registryId: row.id, startedNow: true };
    } catch {
      // Unique-index conflict: another dispatch won the race. Loop re-reads.
      continue;
    }
  }
}

export async function markTemplateReady(registryId: number, boxId: string): Promise<void> {
  const [row] = await db
    .update(boxTemplates)
    .set({ state: "ready", boxId, readyAt: new Date() })
    .where(eq(boxTemplates.id, registryId))
    .returning();
  if (!row) return;
  // A newer template replaces older ready ones; their Boxes are left for the
  // operator/retention path (explicit non-goal to delete them here).
  await db
    .update(boxTemplates)
    .set({ state: "superseded" })
    .where(and(eq(boxTemplates.state, "ready"), inArray(boxTemplates.id, (
      await db.select({ id: boxTemplates.id }).from(boxTemplates).where(eq(boxTemplates.state, "ready"))
    ).map((r) => r.id).filter((id) => id !== registryId))));
}

export async function markTemplateFailed(registryId: number, error: string): Promise<void> {
  await db
    .update(boxTemplates)
    .set({ state: "failed", error })
    .where(eq(boxTemplates.id, registryId));
}
