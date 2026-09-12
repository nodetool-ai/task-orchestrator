import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { agentSessions, runnerInstances, spritePoolEntries } from "../db/schema";
import { spritesPoolStore } from "../lib/runner/sprites-pool-store";

beforeEach(async () => {
  await db.delete(spritePoolEntries);
  await db.delete(runnerInstances);
  await db.delete(agentSessions);
});

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

  it("claims one ready entry and binds the runner atomically", async () => {
    const run = (await db.insert(agentSessions).values({ status: "pending", goal: "<implement>", toolsProfile: "", cwdStrategy: "worktree" }).returning())[0]!;
    await db.insert(runnerInstances).values({ runId: run.id, provider: "sprites", state: "creating", generationState: "stopped" });
    const pool = (await db.insert(spritePoolEntries).values({ spriteName: `pool-test-${crypto.randomUUID()}`, fingerprint: "fp-claim", checkpointId: "cp", baselineManifest: {}, state: "ready" }).returning())[0]!;
    const claimed = await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: pool.fingerprint });
    expect(claimed).toMatchObject({ id: pool.id, state: "claimed", runId: run.id, restoreState: "pending" });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id)))[0]).toMatchObject({ spriteName: pool.spriteName });
    expect(await spritesPoolStore.claimForRun({ runId: run.id, fingerprint: pool.fingerprint })).toMatchObject({ id: pool.id });
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

  it("recovers expired preparation leases without allowing readiness", async () => {
    const row = await spritesPoolStore.reservePreparation({ spriteName: `pool-expired-${crypto.randomUUID()}`, fingerprint: "fp-expired", checkpointId: "pending", baselineManifest: {}, leaseMs: 1 }, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await spritesPoolStore.reconcile(Date.now());
    expect(result.expired.some((item) => item.id === String(row!.id))).toBe(true);
    expect((await spritesPoolStore.listActive()).find((item) => item.id === row!.id)?.state).toBe("draining");
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
