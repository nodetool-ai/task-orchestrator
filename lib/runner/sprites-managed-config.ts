import { db } from "../../db";
import { spriteBaselineProfiles } from "../../db/schema";
import { getConfiguredSpriteBaselines, type ConfiguredSpriteBaseline } from "./sprites-pool-config";

export type ManagedBaseline = { repositoryId: string; userId: number; spec: Record<string, unknown> };

/** Overrides may replace only a single owner's repository profile. Shared
 * deployment profiles remain administrator-managed; generic capacity is never
 * silently taken away from other workloads. */
export function mergeSpriteBaselines(workerSha: string, overrides: ManagedBaseline[], raw?: string): ConfiguredSpriteBaseline[] {
  let specs = getConfiguredSpriteBaselines(workerSha, raw);
  for (const row of overrides) {
    const [candidate] = getConfiguredSpriteBaselines(workerSha, JSON.stringify([row.spec]));
    if (!candidate?.manifest.dependency || candidate.repositoryId !== row.repositoryId
      || candidate.allowedUserIds?.length !== 1 || candidate.allowedUserIds[0] !== row.userId) {
      throw new Error("Managed baseline scope does not match its stored owner and repository");
    }
    const scoped = specs.filter((spec) => spec.repositoryId === row.repositoryId && spec.allowedUserIds?.includes(row.userId));
    if (scoped.some((spec) => spec.allowedUserIds!.length !== 1)) {
      throw new Error("Shared deployment baselines must be changed by an administrator");
    }
    specs = specs.filter((spec) => !scoped.includes(spec));
    if (specs.some((spec) => spec.fingerprint === candidate.fingerprint)) {
      throw new Error("This baseline fingerprint is already managed in another scope");
    }
    specs.push(candidate);
  }
  return specs;
}

export async function getEffectiveSpriteBaselines(workerSha: string) {
  return mergeSpriteBaselines(workerSha, await db.select().from(spriteBaselineProfiles));
}
