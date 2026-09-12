import { and, desc, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { agentSessions, runnerInstances, spritePoolEntries, spritePoolAssignments } from "../../db/schema";
import { spriteLog } from "./sprites-log";
import { config } from "../config";

export type SpritePoolState = "preparing" | "ready" | "claimed" | "recycling" | "draining" | "deleting" | "deleted" | "failed";
export type BaselineClass = "generic" | "repository";
export type SpritePoolEntry = typeof spritePoolEntries.$inferSelect;

export interface BaselineInput {
  spriteName: string;
  fingerprint: string;
  checkpointId: string;
  baselineManifest: Record<string, unknown>;
  baselineClass?: BaselineClass;
  leaseMs?: number;
  maxReady?: number;
  fingerprintTarget?: number;
}

export interface ClaimInput {
  runId: number;
  fingerprint: string;
  expectedWorkerGeneration?: number;
  expectedProviderOperationId?: string | null;
  leaseMs?: number;
  expectedRunnerState?: string;
  reuseAffinity?: { userId: number; repositoryId: string };
}

function expiry(ms = 10 * 60_000): Date {
  return new Date(Date.now() + ms);
}

/** Durable state for the provider-facing warm-pool controller.
 *
 * Provider calls deliberately do not live here. Callers reserve a row before
 * creating a Sprite, then mark it ready only after checkpoint verification.
 */
export const spritesPoolStore = {
  async reservePreparation(input: BaselineInput | { fingerprint: string; maxTotal: number; leaseMs: number; maxReady?: number; fingerprintTarget?: number }, maxSprites?: number): Promise<SpritePoolEntry | { id: string; fingerprint: string; leaseToken: string; spriteName: string } | null> {
    const managerInput = !("spriteName" in input);
    const baselineInput: BaselineInput = managerInput ? {
      spriteName: `pool-${crypto.randomUUID()}`,
      fingerprint: input.fingerprint,
      checkpointId: "pending",
      baselineManifest: {},
      leaseMs: input.leaseMs,
    } : input;
    const limit = managerInput ? input.maxTotal : maxSprites;
    const effectiveLimit = limit && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
    const readyTarget = managerInput ? input.maxReady : baselineInput.maxReady;
    const fingerprintTarget = managerInput ? input.fingerprintTarget : baselineInput.fingerprintTarget;
    if (effectiveLimit < 0) throw new Error("maxSprites must be non-negative");
    return db.transaction(async (tx) => {
      // This lock spans replicas and makes the count-plus-insert reservation
      // atomic. Assigned entries remain counted against the provider limit.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sprite-pool-capacity'))`);
      const countRows = await tx.execute<{ count: number | string }>(sql`
        SELECT ((SELECT count(*) FROM sprite_pool_entries WHERE state <> 'deleted') +
          (SELECT count(*) FROM runner_instances ri LEFT JOIN sprite_pool_entries pe ON pe.sprite_name=ri.sprite_name
            WHERE ri.provider='sprites' AND ri.sprite_name IS NOT NULL
              AND ri.state NOT IN ('gone','stopped') AND pe.id IS NULL))::int AS count
      `);
      if (Number(countRows[0]?.count ?? 0) >= effectiveLimit) { spriteLog("sprites_pool_reservation_declined", { fingerprint: baselineInput.fingerprint, reason: "total_capacity" }, "debug"); return null; }
      if (readyTarget !== undefined) {
        // Failed/deleting unused resources still consume the warm budget until
        // deletion is confirmed; an API outage must not cause unbounded refill.
        const targetRows = await tx.execute<{ count: number | string }>(sql`SELECT count(*)::int AS count FROM sprite_pool_entries WHERE run_id IS NULL AND state <> 'deleted'`);
        if (Number(targetRows[0]?.count ?? 0) >= readyTarget) { spriteLog("sprites_pool_reservation_declined", { fingerprint: baselineInput.fingerprint, reason: "unused_budget" }, "debug"); return null; }
      }
      if (fingerprintTarget !== undefined) {
        const fpRows = await tx.execute<{ count: number | string }>(sql`SELECT count(*)::int AS count FROM sprite_pool_entries WHERE fingerprint=${baselineInput.fingerprint}
          AND (state IN ('preparing','ready') OR (${config.sprites.poolReuse} AND baseline_class='repository' AND state IN ('claimed','recycling')))`);
        if (Number(fpRows[0]?.count ?? 0) >= fingerprintTarget) { spriteLog("sprites_pool_reservation_declined", { fingerprint: baselineInput.fingerprint, reason: "fingerprint_target" }, "debug"); return null; }
      }
      const now = new Date();
      const backoffRows = await tx.execute<{ count: number | string }>(sql`SELECT count(*)::int AS count FROM sprite_pool_entries WHERE fingerprint=${baselineInput.fingerprint} AND state='failed' AND lease_expires_at > ${now.toISOString()}`);
      if (Number(backoffRows[0]?.count ?? 0) > 0) { spriteLog("sprites_pool_reservation_declined", { fingerprint: baselineInput.fingerprint, reason: "retry_backoff" }, "debug"); return null; }
      const [row] = await tx.insert(spritePoolEntries).values({
        provider: "sprites",
        spriteName: baselineInput.spriteName,
        state: "preparing",
        baselineClass: baselineInput.baselineClass ?? "generic",
        fingerprint: baselineInput.fingerprint,
        checkpointId: baselineInput.checkpointId,
        baselineManifest: baselineInput.baselineManifest,
        leaseToken: sql`gen_random_uuid()`,
        leaseExpiresAt: expiry(baselineInput.leaseMs),
      }).returning();
      return managerInput && row ? { id: String(row.id), fingerprint: row.fingerprint, leaseToken: String(row.leaseToken), spriteName: row.spriteName } : row ?? null;
    });
  },

  async countCapacity(): Promise<{ total: number; preparing: number; ready: number; byFingerprint: Record<string, { preparing: number; ready: number }> }> {
    const rows = await db.select({ state: spritePoolEntries.state, count: sql<number>`count(*)::int` }).from(spritePoolEntries).where(notInArray(spritePoolEntries.state, ["deleted"])).groupBy(spritePoolEntries.state);
    const fpRows = await db.select({ fingerprint: spritePoolEntries.fingerprint, state: spritePoolEntries.state, count: sql<number>`count(*)::int` }).from(spritePoolEntries).where(notInArray(spritePoolEntries.state, ["deleted"])).groupBy(spritePoolEntries.fingerprint, spritePoolEntries.state);
    const byState = new Map(rows.map((r) => [r.state, Number(r.count)]));
    const other = await db.execute<{ count: number | string }>(sql`SELECT count(*)::int AS count FROM runner_instances ri LEFT JOIN sprite_pool_entries pe ON pe.sprite_name=ri.sprite_name WHERE ri.provider='sprites' AND ri.sprite_name IS NOT NULL AND ri.state NOT IN ('gone','stopped') AND pe.id IS NULL`);
    const byFingerprint: Record<string, { preparing: number; ready: number }> = {};
    for (const row of fpRows) { const item = byFingerprint[row.fingerprint] ?? { preparing: 0, ready: 0 }; if (row.state === "preparing") item.preparing = Number(row.count); if (row.state === "ready") item.ready = Number(row.count); byFingerprint[row.fingerprint] = item; }
    return { total: rows.reduce((n, r) => n + Number(r.count), 0) + Number(other[0]?.count ?? 0), preparing: byState.get("preparing") ?? 0, ready: byState.get("ready") ?? 0, byFingerprint };
  },

  async completePreparation(input: { reservationId: string; leaseToken: string; spriteName?: string; checkpointId: string; baselineManifest?: Record<string, unknown> }): Promise<void> {
    if (!input.checkpointId.trim() || input.checkpointId === "pending") throw new Error("A completed baseline needs a checkpoint ID");
    const now = new Date();
    const [row] = await db.update(spritePoolEntries).set({
      checkpointId: input.checkpointId, state: "ready", leaseExpiresAt: null, updatedAt: now,
    }).where(and(
      eq(spritePoolEntries.id, Number(input.reservationId)), eq(spritePoolEntries.state, "preparing"),
      eq(spritePoolEntries.leaseToken, input.leaseToken),
      input.spriteName ? eq(spritePoolEntries.spriteName, input.spriteName) : undefined,
      input.baselineManifest ? eq(spritePoolEntries.baselineManifest, input.baselineManifest) : undefined,
      sql`${spritePoolEntries.leaseExpiresAt} > ${now.toISOString()}`,
    )).returning({ id: spritePoolEntries.id });
    if (!row) throw new Error("preparation lease or immutable baseline identity is no longer valid");
  },

  async renewPreparation(input: { reservationId: string; leaseToken: string; leaseMs: number }): Promise<boolean> {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error("Preparation lease duration must be positive");
    }
    const now = new Date();
    const [row] = await db.update(spritePoolEntries).set({
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      updatedAt: now,
    }).where(and(
      eq(spritePoolEntries.id, Number(input.reservationId)),
      eq(spritePoolEntries.state, "preparing"),
      eq(spritePoolEntries.leaseToken, input.leaseToken),
      sql`${spritePoolEntries.leaseExpiresAt} > ${now.toISOString()}`,
    )).returning({ id: spritePoolEntries.id });
    return Boolean(row);
  },

  async failPreparation(input: { reservationId: string; leaseToken: string; reason: string; retryAt: number }): Promise<void> {
    await db.update(spritePoolEntries).set({ state: "failed", restoreState: "failed", lastError: input.reason.slice(0, 4000), leaseExpiresAt: new Date(input.retryAt), updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, Number(input.reservationId)), eq(spritePoolEntries.state, "preparing"), eq(spritePoolEntries.leaseToken, input.leaseToken)));
  },

  async listUnused(input: { fingerprint?: string } = {}): Promise<Array<{ id: string; spriteName: string; fingerprint: string; state: SpritePoolState; updatedAt: Date }>> {
    const rows = await db.select().from(spritePoolEntries).where(and(isNull(spritePoolEntries.runId), eq(spritePoolEntries.state, "ready"), input.fingerprint ? eq(spritePoolEntries.fingerprint, input.fingerprint) : undefined)).orderBy(desc(spritePoolEntries.updatedAt));
    return rows.map((r) => ({ id: String(r.id), spriteName: r.spriteName, fingerprint: r.fingerprint, state: r.state as SpritePoolState, updatedAt: r.updatedAt }));
  },

  async markDraining(id: string): Promise<boolean> { return Boolean(await this.requestDrain(Number(id)));
  },

  async reconcile(now = Date.now()): Promise<{ expired: Array<{ id: string; fingerprint: string; leaseToken: string }>; deletions: Array<{ id: string; spriteName: string; fingerprint: string; state: SpritePoolState }> }> {
    const at = new Date(now);
    const expiredRows = await db.select({ id: spritePoolEntries.id, fingerprint: spritePoolEntries.fingerprint, leaseToken: spritePoolEntries.leaseToken }).from(spritePoolEntries).where(and(isNull(spritePoolEntries.runId), notInArray(spritePoolEntries.state, ["deleted", "claimed"]), sql`${spritePoolEntries.leaseExpiresAt} IS NOT NULL AND ${spritePoolEntries.leaseExpiresAt} < ${at.toISOString()}`));
    await this.recoverExpiredLeases(at);
    const rows = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.state, "deleting"));
    return { expired: expiredRows.filter((r) => Boolean(r.leaseToken)).map((r) => ({ id: String(r.id), fingerprint: r.fingerprint, leaseToken: String(r.leaseToken) })), deletions: rows.map((r) => ({ id: String(r.id), spriteName: r.spriteName, fingerprint: r.fingerprint, state: r.state as SpritePoolState })) };
  },

  /** Claim and bind in one transaction. Existing run bindings are adopted
   * idempotently, which makes dispatch retries safe. */
  async claimForRun(input: ClaimInput): Promise<SpritePoolEntry | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('sprite-pool-claim:' || ${String(input.runId)}))`);
      // Lock the authoritative runner row before checking guards. This makes
      // generation/provider-operation CAS robust against reconciliation racing
      // the claim transaction.
      const runnerRows = await tx.select().from(runnerInstances).where(eq(runnerInstances.runId, input.runId)).limit(1).for("update");
      const runner = runnerRows[0];
      const [run] = await tx.select({ userId: agentSessions.userId, repoId: agentSessions.repoId, branch: agentSessions.branch })
        .from(agentSessions).where(eq(agentSessions.id, input.runId)).for("share");
      if (input.reuseAffinity && (input.reuseAffinity.userId !== run?.userId || input.reuseAffinity.repositoryId !== run?.repoId)) {
        throw new Error("Reusable Sprite affinity differs from the run owner or repository");
      }
      if (runner) {
        if (input.expectedWorkerGeneration !== undefined && runner.workerGeneration !== input.expectedWorkerGeneration) throw new Error("runner worker generation changed during pool claim");
        if (input.expectedProviderOperationId !== undefined && (runner.providerOperationId ?? null) !== (input.expectedProviderOperationId ?? null)) throw new Error("runner provider operation changed during pool claim");
        if (input.expectedRunnerState !== undefined && runner.state !== input.expectedRunnerState) throw new Error("runner state changed during pool claim");
      }
      const existing = await tx.select().from(spritePoolEntries).where(eq(spritePoolEntries.runId, input.runId)).limit(1);
      if (existing[0] && !["deleted", "failed"].includes(existing[0].state)) {
        if (!runner || runner.spriteName !== existing[0].spriteName) return null;
        return existing[0];
      }
      const candidates = await tx.select().from(spritePoolEntries)
        .where(and(eq(spritePoolEntries.fingerprint, input.fingerprint), eq(spritePoolEntries.state, "ready"),
          or(isNull(spritePoolEntries.reuseUserId), run?.userId ? eq(spritePoolEntries.reuseUserId, run.userId) : undefined),
          or(isNull(spritePoolEntries.reuseRepositoryId), run?.repoId ? eq(spritePoolEntries.reuseRepositoryId, run.repoId) : undefined)))
        .orderBy(desc(spritePoolEntries.createdAt)).limit(1).for("update", { skipLocked: true });
      const entry = candidates[0];
      if (!entry) return null;
      const now = new Date();
      const [claimed] = await tx.update(spritePoolEntries).set({
        state: "claimed", runId: input.runId, leaseToken: sql`gen_random_uuid()`, leaseExpiresAt: expiry(input.leaseMs), updatedAt: now,
        ...(input.reuseAffinity ? { reuseUserId: input.reuseAffinity.userId, reuseRepositoryId: input.reuseAffinity.repositoryId } : {}),
      }).where(and(eq(spritePoolEntries.id, entry.id), eq(spritePoolEntries.state, "ready"))).returning();
      if (!claimed) return null;

      if (runner) {
        const [bound] = await tx.update(runnerInstances).set({ provider: "sprites", spriteName: claimed.spriteName, state: "creating", generationState: "booting" }).where(and(eq(runnerInstances.runId, input.runId), ...(input.expectedWorkerGeneration === undefined ? [] : [eq(runnerInstances.workerGeneration, input.expectedWorkerGeneration)]), ...(input.expectedProviderOperationId === undefined ? [] : [input.expectedProviderOperationId === null ? isNull(runnerInstances.providerOperationId) : eq(runnerInstances.providerOperationId, input.expectedProviderOperationId)]))).returning();
        if (!bound) throw new Error("runner binding disappeared during pool claim");
      } else throw new Error("runner binding must be preallocated before pool claim");
      await tx.insert(spritePoolAssignments).values({ poolEntryId: claimed.id, runId: input.runId, userId: run?.userId,
        repositoryId: run?.repoId, leaseToken: claimed.leaseToken!, generation: runner.workerGeneration, branch: run?.branch });
      return claimed;
    });
  },

  async beginRestore(id: number): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ restoreState: "restoring", updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, id), eq(spritePoolEntries.state, "claimed"), sql`${spritePoolEntries.restoreState} IN ('pending','restoring')`)).returning();
    return row ?? null;
  },

  async markRestored(id: number): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ restoreState: "restored", baselineRestoredAt: new Date(), updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, id), eq(spritePoolEntries.state, "claimed"), eq(spritePoolEntries.restoreState, "restoring"))).returning();
    return row ?? null;
  },

  async fail(id: number, error: string): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ state: "failed", restoreState: "failed", lastError: error.slice(0, 4000), updatedAt: new Date() }).where(eq(spritePoolEntries.id, id)).returning();
    return row ?? null;
  },

  async requestDrain(id: number, reason?: string): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ state: "draining", lastError: reason?.slice(0, 4000) ?? null, deleteRequestedAt: new Date(), updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, id), isNull(spritePoolEntries.runId), notInArray(spritePoolEntries.state, ["deleted", "claimed"]))).returning();
    return row ?? null;
  },

  async markDeleting(id: number): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ state: "deleting", updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, id), eq(spritePoolEntries.state, "draining"))).returning();
    return row ?? null;
  },

  async markDeleted(id: number): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ state: "deleted", deletedAt: new Date(), updatedAt: new Date() }).where(and(eq(spritePoolEntries.id, id), eq(spritePoolEntries.state, "deleting"))).returning();
    return row ?? null;
  },

  async findBySpriteName(name: string): Promise<SpritePoolEntry | null> {
    const [row] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.spriteName, name)).limit(1);
    return row ?? null;
  },

  async findByRunId(runId: number): Promise<SpritePoolEntry | null> {
    const [row] = await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.runId, runId)).limit(1);
    return row ?? null;
  },

  async requestDeletionBySpriteName(name: string, reason?: string): Promise<SpritePoolEntry | null> {
    const [row] = await db.update(spritePoolEntries).set({ state: "deleting", deleteRequestedAt: new Date(), lastError: reason?.slice(0, 4000) ?? null, updatedAt: new Date() }).where(and(eq(spritePoolEntries.spriteName, name), notInArray(spritePoolEntries.state, ["deleted", "deleting"]))).returning();
    return row ?? null;
  },

  async recoverExpiredLeases(now = new Date()): Promise<number> {
    const rows = await db.update(spritePoolEntries).set({
      state: "draining",
      deleteRequestedAt: now,
      lastError: sql`CASE WHEN ${spritePoolEntries.state} = 'preparing' THEN 'preparation lease expired' ELSE ${spritePoolEntries.lastError} END`,
      updatedAt: now,
    }).where(and(isNull(spritePoolEntries.runId), notInArray(spritePoolEntries.state, ["deleted", "claimed"]), sql`${spritePoolEntries.leaseExpiresAt} IS NOT NULL AND ${spritePoolEntries.leaseExpiresAt} < ${now.toISOString()}`)).returning({ id: spritePoolEntries.id });
    return rows.length;
  },

  async listActive(): Promise<SpritePoolEntry[]> {
    return db.select().from(spritePoolEntries).where(notInArray(spritePoolEntries.state, ["deleted"])).orderBy(desc(spritePoolEntries.createdAt));
  },
};

export const spritePoolStore = spritesPoolStore;
