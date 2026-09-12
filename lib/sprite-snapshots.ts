import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { repositories, spriteBaselineProfiles, spritePoolEntries } from "../db/schema";
import type { AppApiContext } from "./app-api/types";
import { config } from "./config";
import { workerBundleId } from "./worker-bundle";
import { cloneUrlFromRemote } from "./repo-checkout";
import { spriteCaller } from "./sprite-access";
import { getEffectiveSpriteBaselines, mergeSpriteBaselines } from "./runner/sprites-managed-config";
import { generateGithubSpriteBaseline } from "./runner/sprites-baseline-github";
import type { ConfiguredSpriteBaseline } from "./runner/sprites-pool-config";

async function repositoryScope(ctx: AppApiContext, repoId: string) {
  const owner = await spriteCaller(ctx);
  if (owner.repoId && owner.repoId !== repoId) throw new Error("Snapshot repository differs from the calling run");
  const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId));
  if (!repo) throw new Error("Registered repository not found");
  return { ...owner, repo };
}

export async function listSnapshots(ctx: AppApiContext) {
  const owner = await spriteCaller(ctx);
  const profiles = (await getEffectiveSpriteBaselines(await workerBundleId())).filter((s) =>
    s.allowedUserIds?.includes(owner.userId) && (!owner.repoId || s.repositoryId === owner.repoId));
  const entries = profiles.length ? await db.select({ id: spritePoolEntries.id, fingerprint: spritePoolEntries.fingerprint,
    state: spritePoolEntries.state, checkpointId: spritePoolEntries.checkpointId, lastError: spritePoolEntries.lastError,
    createdAt: spritePoolEntries.createdAt, updatedAt: spritePoolEntries.updatedAt })
    .from(spritePoolEntries).where(and(isNull(spritePoolEntries.runId),
      inArray(spritePoolEntries.fingerprint, profiles.map((p) => p.fingerprint))))
    .orderBy(desc(spritePoolEntries.id)).limit(100) : [];
  return { poolSize: config.sprites.poolSize, profiles: profiles.map(({ allowedUserIds, ...profile }) => ({
    ...profile, editable: allowedUserIds?.length === 1,
    entries: entries.filter((e) => e.fingerprint === profile.fingerprint),
  })) };
}

async function saveSpec(ctx: AppApiContext, repoId: string,
  value: Record<string, unknown> | ((current: ConfiguredSpriteBaseline[]) => Record<string, unknown>)) {
  const { userId } = await repositoryScope(ctx, repoId);
  const workerSha = await workerBundleId();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sprite-baseline-profiles'))`);
    const existing = await tx.select().from(spriteBaselineProfiles);
    // Evaluate patches under the same lock as replacement: a concurrent target
    // change cannot accidentally restore an older recipe it read beforehand.
    const spec = typeof value === "function" ? value(mergeSpriteBaselines(workerSha, existing)) : value;
    const overrides = existing.filter((p) => p.repositoryId !== repoId || p.userId !== userId);
    const candidate = { repositoryId: repoId, userId, spec };
    const merged = mergeSpriteBaselines(workerSha, [...overrides, candidate]);
    if (merged.reduce((n, p) => n + p.target, 0) > config.sprites.poolSize) {
      throw new Error("Snapshot targets exceed the configured pool size; reduce your existing target or ask an administrator to allocate capacity");
    }
    await tx.insert(spriteBaselineProfiles).values(candidate).onConflictDoUpdate({
      target: [spriteBaselineProfiles.repositoryId, spriteBaselineProfiles.userId], set: { spec, updatedAt: new Date() },
    });
  });
  // The regular provider sweep also reads the durable config after a restart.
  const { getRunnerProvider } = await import("./runner/provider");
  const provider = getRunnerProvider();
  if ("refreshPool" in provider && typeof provider.refreshPool === "function") provider.refreshPool();
  return listSnapshots(ctx);
}

export async function prepareSnapshot(ctx: AppApiContext, input: { repoId: string; ref: string; recipe: Record<string, unknown>; target?: number }) {
  const { repo, userId } = await repositoryScope(ctx, input.repoId);
  const remote = cloneUrlFromRemote(repo.remote);
  if (!remote) throw new Error("Snapshot preparation requires a registered GitHub remote");
  // Identity cannot be supplied in the recipe, even via untyped direct calls.
  const spec = await generateGithubSpriteBaseline(remote, input.ref, { ...input.recipe,
    repositoryId: repo.id, repository: remote, allowedUserIds: [userId], target: input.target ?? 1 });
  return saveSpec(ctx, repo.id, spec);
}

export async function setSnapshotTarget(ctx: AppApiContext, input: { repoId: string; target: number }) {
  const { userId } = await repositoryScope(ctx, input.repoId);
  if (!Number.isSafeInteger(input.target) || input.target < 0) throw new Error("Snapshot target must be a nonnegative integer");
  return saveSpec(ctx, input.repoId, (profiles) => {
    const profile = profiles.find((p) => p.repositoryId === input.repoId && p.allowedUserIds?.includes(userId));
    if (!profile || profile.allowedUserIds?.length !== 1) throw new Error("No editable snapshot profile for this repository");
    const { fingerprint: _fingerprint, ...spec } = profile;
    const { workerBundleSha: _sha, ...manifest } = spec.manifest;
    return { ...spec, manifest, target: input.target };
  });
}

export async function retireSnapshot(ctx: AppApiContext, id: number) {
  const { userId, repoId } = await spriteCaller(ctx);
  const fingerprints = (await getEffectiveSpriteBaselines(await workerBundleId()))
    .filter((p) => p.allowedUserIds?.length === 1 && p.allowedUserIds[0] === userId && (!repoId || p.repositoryId === repoId))
    .map((p) => p.fingerprint);
  if (!fingerprints.length) throw new Error("No editable snapshot profile");
  // One CAS: assignment racing this call wins or loses atomically. Preparing
  // entries keep their lease; retirement cannot interrupt a provisioner.
  const [row] = await db.update(spritePoolEntries).set({ state: "draining", deleteRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(spritePoolEntries.id, id), isNull(spritePoolEntries.runId), eq(spritePoolEntries.state, "ready"),
      inArray(spritePoolEntries.fingerprint, fingerprints))).returning({ id: spritePoolEntries.id, state: spritePoolEntries.state });
  if (!row) throw new Error("Unused ready snapshot not found in the caller's scope");
  return { ...row, replenishment: "The configured target remains active; use setTarget(0) to pause it." };
}
