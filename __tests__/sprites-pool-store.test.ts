import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { agentSessions, repositories, runnerInstances, spritePoolAssignments, spritePoolEntries, users } from "../db/schema";
import { spritesPoolStore } from "../lib/runner/sprites-pool-store";

beforeEach(async () => {
  await db.delete(spritePoolEntries);
  await db.delete(runnerInstances);
  await db.delete(agentSessions);
});
afterEach(() => vi.unstubAllEnvs());

describe("Sprite pool store (Postgres)", () => {
  it("does not count runner rows without a provider resource against capacity", async () => {
    const run = (await db.insert(agentSessions).values({
      status: "failed",
      goal: "<implement>",
      toolsProfile: "",
      cwdStrategy: "worktree",
    }).returning())[0]!;
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: null,
      state: "starting",
      generationState: "stopped",
    });

    await expect(spritesPoolStore.countCapacity()).resolves.toMatchObject({ total: 0 });
    await expect(spritesPoolStore.reservePreparation({
      spriteName: `pool-after-phantom-${crypto.randomUUID()}`,
      fingerprint: "fp-after-phantom",
      checkpointId: "pending",
      baselineManifest: {},
    }, 1)).resolves.not.toBeNull();
  });

  it("keeps failed deletion resources inside the unused budget without a hard cap", async () => {
    await db.insert(spritePoolEntries).values({ spriteName: "pool-delete-outage", state: "deleting",
      fingerprint: "old", baselineManifest: {}, checkpointId: "cp-old" });
    const reserve = () => spritesPoolStore.reservePreparation({ spriteName: `pool-new-${crypto.randomUUID()}`,
      fingerprint: "new", baselineManifest: {}, checkpointId: "pending", maxReady: 1 }, 0);
    expect(await reserve()).toBeNull();
    const entry = await spritesPoolStore.findBySpriteName("pool-delete-outage");
    await spritesPoolStore.markDeleted(entry!.id);
    expect(await reserve()).not.toBeNull();
  });
  it("reserves capacity and fences expired preparation completion", async () => {
    const row = await spritesPoolStore.reservePreparation({ spriteName: `pool-test-${crypto.randomUUID()}`, fingerprint: "fp", checkpointId: "pending", baselineManifest: {}, leaseMs: 1 }, 1);
    expect(row).toMatchObject({ state: "preparing", fingerprint: "fp" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(spritesPoolStore.completePreparation({ reservationId: String(row!.id), leaseToken: String(row!.leaseToken), checkpointId: "cp" })).rejects.toThrow("lease");
  });

  it("renews only a live preparation lease owned by the matching token", async () => {
    const reserve = (label: string) => spritesPoolStore.reservePreparation({
      spriteName: `pool-renew-${label}-${crypto.randomUUID()}`,
      fingerprint: `fp-renew-${label}`,
      checkpointId: "pending",
      baselineManifest: {},
      leaseMs: 60_000,
    }, 0);

    const live = await reserve("live");
    const liveBefore = (await spritesPoolStore.findBySpriteName(live!.spriteName))!.leaseExpiresAt!.getTime();
    expect(await spritesPoolStore.renewPreparation({
      reservationId: String(live!.id), leaseToken: String(live!.leaseToken), leaseMs: 120_000,
    })).toBe(true);
    expect((await spritesPoolStore.findBySpriteName(live!.spriteName))!.leaseExpiresAt!.getTime()).toBeGreaterThan(liveBefore);

    expect(await spritesPoolStore.renewPreparation({
      reservationId: String(live!.id), leaseToken: crypto.randomUUID(), leaseMs: 120_000,
    })).toBe(false);

    const expired = await reserve("expired");
    await db.update(spritePoolEntries).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(spritePoolEntries.id, Number(expired!.id)));
    expect(await spritesPoolStore.renewPreparation({
      reservationId: String(expired!.id), leaseToken: String(expired!.leaseToken), leaseMs: 120_000,
    })).toBe(false);

    const ready = await reserve("ready");
    await spritesPoolStore.completePreparation({ reservationId: String(ready!.id), leaseToken: String(ready!.leaseToken), checkpointId: "cp-ready" });
    expect(await spritesPoolStore.renewPreparation({
      reservationId: String(ready!.id), leaseToken: String(ready!.leaseToken), leaseMs: 120_000,
    })).toBe(false);

    const draining = await reserve("draining");
    await db.update(spritePoolEntries).set({ state: "draining" }).where(eq(spritePoolEntries.id, Number(draining!.id)));
    expect(await spritesPoolStore.renewPreparation({
      reservationId: String(draining!.id), leaseToken: String(draining!.leaseToken), leaseMs: 120_000,
    })).toBe(false);
  });

  it("claims one ready entry and binds the runner atomically", async () => {
    const run = (await db.insert(agentSessions).values({ status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" }).returning())[0]!;
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "creating", generationState: "stopped" });
    const pool = (await db.insert(spritePoolEntries).values({ spriteName: `pool-test-${crypto.randomUUID()}`, fingerprint: "fp-claim", checkpointId: "cp", baselineManifest: {}, state: "ready" }).returning())[0]!;
    const claimed = await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: pool.fingerprint });
    expect(claimed).toMatchObject({ id: pool.id, state: "claimed", runId: run.id, restoreState: "pending" });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0]).toMatchObject({ spriteName: pool.spriteName });
    expect(await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: pool.fingerprint })).toMatchObject({ id: pool.id });
  });

  it("keeps reusable ready entries within one owner and repository and records the successful assignment", async () => {
    const suffix = crypto.randomUUID();
    const owners = await db.insert(users).values([
      { email: `affinity-owner-${suffix}@test.invalid`, passwordHash: "unused" },
      { email: `affinity-other-${suffix}@test.invalid`, passwordHash: "unused" },
    ]).returning();
    const repositoryIds = [`R-affinity-a-${suffix}`, `R-affinity-b-${suffix}`];
    await db.insert(repositories).values(repositoryIds.map((id) => ({ id, name: id, remote: `https://github.com/acme/${id}` })));
    const runs = await db.insert(agentSessions).values([
      { status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree", userId: owners[1]!.id, repoId: repositoryIds[0] },
      { status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree", userId: owners[0]!.id, repoId: repositoryIds[1] },
      { status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree", userId: owners[0]!.id, repoId: repositoryIds[0], branch: "claude/affinity" },
    ]).returning();
    await db.insert(runnerInstances).values(runs.map((run) => ({
      runId: run.id,
      provider: "sprites",
      state: "creating",
      generationState: "stopped",
      workerGeneration: 3,
    })));
    const [pool] = await db.insert(spritePoolEntries).values({
      spriteName: `pool-affinity-${suffix}`,
      fingerprint: `fp-affinity-${suffix}`,
      checkpointId: "cp",
      baselineManifest: {},
      baselineClass: "repository",
      state: "ready",
      reuseUserId: owners[0]!.id,
      reuseRepositoryId: repositoryIds[0],
    }).returning();

    expect(await spritesPoolStore.claimForRun({ runId: runs[0]!.id, fingerprint: pool!.fingerprint })).toBeNull();
    expect(await spritesPoolStore.claimForRun({ runId: runs[1]!.id, fingerprint: pool!.fingerprint })).toBeNull();
    const claimed = await spritesPoolStore.claimForRun({
      runId: runs[2]!.id,
      fingerprint: pool!.fingerprint,
      reuseAffinity: { userId: owners[0]!.id, repositoryId: repositoryIds[0]! },
    });
    expect(claimed).toMatchObject({ id: pool!.id, runId: runs[2]!.id, state: "claimed" });
    const [history] = await db.select().from(spritePoolAssignments).where(eq(spritePoolAssignments.runId, runs[2]!.id));
    expect(history).toMatchObject({
      poolEntryId: pool!.id,
      userId: owners[0]!.id,
      repositoryId: repositoryIds[0],
      generation: 3,
      branch: "claude/affinity",
    });
  });

  it("counts claimed reusable repository entries toward their fingerprint fleet target", async () => {
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_REUSE", "1");
    const suffix = crypto.randomUUID();
    const [owner] = await db.insert(users).values({ email: `fleet-${suffix}@test.invalid`, passwordHash: "unused" }).returning();
    const repositoryId = `R-fleet-${suffix}`;
    await db.insert(repositories).values({ id: repositoryId, name: repositoryId });
    const [run] = await db.insert(agentSessions).values({
      status: "pending",
      goal: "<implement>",
      toolsProfile: "",
      cwdStrategy: "worktree",
      userId: owner!.id,
      repoId: repositoryId,
    }).returning();
    await db.insert(runnerInstances).values({
      runId: run!.id,
      provider: "sprites",
      state: "creating",
      generationState: "stopped",
    });
    const fingerprint = `fp-fleet-${suffix}`;
    await db.insert(spritePoolEntries).values({
      spriteName: `pool-fleet-${suffix}`,
      fingerprint,
      checkpointId: "cp",
      baselineManifest: {},
      baselineClass: "repository",
      state: "ready",
    });
    expect(await spritesPoolStore.claimForRun({
      runId: run!.id,
      fingerprint,
      reuseAffinity: { userId: owner!.id, repositoryId },
    })).not.toBeNull();

    await expect(spritesPoolStore.reservePreparation({
      fingerprint,
      maxTotal: 3,
      leaseMs: 60_000,
      fingerprintTarget: 1,
    })).resolves.toBeNull();
  });

  it("serializes competing claims so one ready Sprite has one owner", async () => {
    const runs = await db.insert(agentSessions).values([
      { status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" },
      { status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" },
    ]).returning();
    await db.insert(runnerInstances).values(runs.map((run) => ({ runId: run.id, provider: "sprites", state: "creating", generationState: "stopped" })));
    await db.insert(spritePoolEntries).values({ spriteName: `pool-test-${crypto.randomUUID()}`, fingerprint: "fp-race", checkpointId: "cp", baselineManifest: {}, state: "ready" });
    const claims = await Promise.all(runs.map((run) => spritesPoolStore.claimForRun({ runId: run.id, fingerprint: "fp-race" })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(spritePoolEntries).where(eq(spritePoolEntries.fingerprint, "fp-race"))).toHaveLength(1);
  });

  it("enforces a shared ready target across concurrent reservations", async () => {
    const reservations = await Promise.all(Array.from({ length: 6 }, (_, i) => spritesPoolStore.reservePreparation({
      spriteName: `pool-target-${i}-${crypto.randomUUID()}`, fingerprint: "fp-target", checkpointId: "pending", baselineManifest: {}, maxReady: 2,
    }, 0)));
    expect(reservations.filter(Boolean)).toHaveLength(2);
  });

  it("honors failed preparation backoff for the same fingerprint", async () => {
    const row = await spritesPoolStore.reservePreparation({ spriteName: `pool-backoff-${crypto.randomUUID()}`, fingerprint: "fp-backoff", checkpointId: "pending", baselineManifest: {}, leaseMs: 30_000 }, 0);
    await spritesPoolStore.failPreparation({ reservationId: String(row!.id), leaseToken: String(row!.leaseToken), reason: "provider unavailable", retryAt: Date.now() + 30_000 });
    expect(await spritesPoolStore.reservePreparation({ spriteName: `pool-backoff-2-${crypto.randomUUID()}`, fingerprint: "fp-backoff", checkpointId: "pending", baselineManifest: {} }, 0)).toBeNull();
  });

  it("preserves the preparation failure while draining after backoff", async () => {
    const row = await spritesPoolStore.reservePreparation({ spriteName: `pool-failed-${crypto.randomUUID()}`, fingerprint: "fp-failed", checkpointId: "pending", baselineManifest: {} }, 0);
    const now = Date.now();
    await spritesPoolStore.failPreparation({ reservationId: String(row!.id), leaseToken: String(row!.leaseToken), reason: "baseline command exited 1", retryAt: now - 1 });

    expect(await spritesPoolStore.recoverExpiredLeases(new Date(now))).toBe(1);
    expect(await spritesPoolStore.findBySpriteName(row!.spriteName)).toMatchObject({
      state: "draining",
      lastError: "baseline command exited 1",
    });
  });

  it("recovers expired preparation leases without allowing readiness", async () => {
    const row = await spritesPoolStore.reservePreparation({ spriteName: `pool-expired-${crypto.randomUUID()}`, fingerprint: "fp-expired", checkpointId: "pending", baselineManifest: {}, leaseMs: 1 }, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await spritesPoolStore.reconcile(Date.now());
    expect(result.expired.some((item) => item.id === String(row!.id))).toBe(true);
    expect((await spritesPoolStore.listActive()).find((item) => item.id === row!.id)).toMatchObject({
      state: "draining",
      lastError: "preparation lease expired",
    });
    await expect(spritesPoolStore.completePreparation({ reservationId: String(row!.id), leaseToken: String(row!.leaseToken), checkpointId: "late" })).rejects.toThrow("lease");
  });

  it("rejects a stale provider operation guard", async () => {
    const run = (await db.insert(agentSessions).values({ status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" }).returning())[0]!;
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "creating", generationState: "stopped" });
    const pool = (await db.insert(spritePoolEntries).values({ spriteName: `pool-stale-${crypto.randomUUID()}`, fingerprint: "fp-stale", checkpointId: "cp", baselineManifest: {}, state: "ready" }).returning())[0]!;
    await expect(spritesPoolStore.claimForRun({ runId: run.id, fingerprint: pool.fingerprint, expectedProviderOperationId: crypto.randomUUID() })).rejects.toThrow("provider operation");
  });

  it("permits a new claim after a prior same-run entry is deleted", async () => {
    const run = (await db.insert(agentSessions).values({ status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" }).returning())[0]!;
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "creating", generationState: "stopped" });
    const old = (await db.insert(spritePoolEntries).values({ spriteName: `pool-old-${crypto.randomUUID()}`, fingerprint: "fp-replace", checkpointId: "cp", baselineManifest: {}, state: "claimed", runId: run.id }).returning())[0]!;
    await db.update(spritePoolEntries).set({ state: "deleted", deletedAt: new Date() }).where(eq(spritePoolEntries.id, old.id));
    await db.update(runnerInstances).set({ spriteName: null }).where(eq(runnerInstances.runId, run.id));
    const fresh = (await db.insert(spritePoolEntries).values({ spriteName: `pool-new-${crypto.randomUUID()}`, fingerprint: "fp-replace", checkpointId: "cp", baselineManifest: {}, state: "ready" }).returning())[0]!;
    expect((await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: fresh.fingerprint }))?.id).toBe(fresh.id);
  });

  it("does not drain assigned entries and records provider deletion intent", async () => {
    const row = (await db.insert(spritePoolEntries).values({ spriteName: `pool-test-${crypto.randomUUID()}`, fingerprint: "fp-delete", checkpointId: "cp", baselineManifest: {}, state: "claimed", runId: null }).returning())[0]!;
    expect(await spritesPoolStore.requestDeletionBySpriteName(row.spriteName, "provider outage")).toMatchObject({ state: "deleting", lastError: "provider outage" });
    expect(await spritesPoolStore.markDeleted(row.id)).toMatchObject({ state: "deleted" });
  });
});
