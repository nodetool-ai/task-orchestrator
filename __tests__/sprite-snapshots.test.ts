import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, repositories, spriteBaselineProfiles, spritePoolEntries, users } from "../db/schema";
import { mergeSpriteBaselines, getEffectiveSpriteBaselines } from "../lib/runner/sprites-managed-config";
import { listSnapshots, prepareSnapshot, retireSnapshot, setSnapshotTarget } from "../lib/sprite-snapshots";
import type { AppApiContext } from "../lib/app-api/types";

const sha = "a".repeat(40);
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), generate: vi.fn() }));
vi.mock("../lib/worker-bundle", () => ({ workerBundleId: async () => "a".repeat(40) }));
vi.mock("../lib/runner/provider", () => ({ getRunnerProvider: () => ({ refreshPool: mocks.refresh }) }));
vi.mock("../lib/runner/sprites-baseline-github", () => ({ generateGithubSpriteBaseline: mocks.generate }));
const generic = { target: 2, manifest: { schemaVersion: 1, nodeVersion: "v22.22.3", codexVersion: "0.153.4",
  platform: "linux", architecture: "x64", systemToolsVersion: "sprite-base-v1" } };
const spec = (userId: number, repositoryId = "R-default", revision = sha) => ({ target: 1, repositoryId, allowedUserIds: [userId],
  manifest: { ...generic.manifest, dependency: { repository: "https://github.com/acme/project", revision,
    packageManager: "npm", packageManagerVersion: "10.9.8", installOptions: ["--no-audit"],
    lockfile: { path: "package-lock.json", sha256: "b".repeat(64) }, packageManifests: [{ path: "package.json", sha256: "b".repeat(64) }] } } });
let owner: number;
let other: number;
let ctx: AppApiContext;
beforeEach(async () => {
  await db.delete(spriteBaselineProfiles);
  await db.delete(spritePoolEntries);
  const inserted = await db.insert(users).values([
    { email: `sprite-${crypto.randomUUID()}@test.invalid`, passwordHash: "unused" },
    { email: `sprite-${crypto.randomUUID()}@test.invalid`, passwordHash: "unused" },
  ]).returning();
  [owner, other] = inserted.map((u) => u.id);
  ctx = { author: "test", userId: owner };
  await db.update(repositories).set({ remote: "https://github.com/acme/project" }).where(eq(repositories.id, "R-default"));
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_SIZE", "3");
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([generic, spec(owner)]));
  mocks.generate.mockImplementation(async (_remote, _ref, recipe) => ({ ...spec(owner), allowedUserIds: recipe.allowedUserIds, repositoryId: recipe.repositoryId, target: recipe.target }));
  mocks.refresh.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("agent-managed Sprite snapshots", () => {
  it("persists pause/resume over env defaults without taking generic capacity", async () => {
    await setSnapshotTarget(ctx, { repoId: "R-default", target: 0 });
    expect((await getEffectiveSpriteBaselines(sha)).map((p) => p.target)).toEqual([2, 0]);
    expect(await db.select().from(spriteBaselineProfiles)).toHaveLength(1);
    await setSnapshotTarget(ctx, { repoId: "R-default", target: 1 });
    expect((await listSnapshots(ctx)).profiles[0].target).toBe(1);
    await expect(setSnapshotTarget(ctx, { repoId: "R-default", target: 2 })).rejects.toThrow(/pool size/);
    expect((await getEffectiveSpriteBaselines(sha)).map((p) => p.target)).toEqual([2, 1]);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it("derives recipe ownership and remote from persisted run and registered repository", async () => {
    const [run] = await db.insert(agentSessions).values({ userId: owner, repoId: "R-default", goal: "<chat>" }).returning();
    await prepareSnapshot({ ...ctx, runId: run.id, userId: other }, { repoId: "R-default", ref: "main", recipe: {
      packageManagerVersion: "10.9.8", repository: "https://github.com/foreign/repo", allowedUserIds: [other], repositoryId: "foreign",
    } });
    expect(mocks.generate).toHaveBeenCalledWith("https://github.com/acme/project", "main", expect.objectContaining({
      repositoryId: "R-default", repository: "https://github.com/acme/project", allowedUserIds: [owner],
    }));
    expect((await listSnapshots({ ...ctx, userId: other })).profiles).toEqual([]);
    await expect(setSnapshotTarget({ ...ctx, runId: 99999999 }, { repoId: "R-default", target: 0 })).rejects.toThrow(/authenticated/);
    await expect(prepareSnapshot({ ...ctx, runId: run.id }, { repoId: "elsewhere", ref: "main", recipe: {} })).rejects.toThrow(/repository differs/);
  });

  it("rejects shared profile mutation, forged stored scope and cross-owner fingerprint collisions", () => {
    const managed = { repositoryId: "R-default", userId: owner, spec: spec(owner) };
    expect(() => mergeSpriteBaselines(sha, [managed], JSON.stringify([{ ...spec(owner), allowedUserIds: [owner, other] }]))).toThrow(/Shared/);
    expect(() => mergeSpriteBaselines(sha, [{ ...managed, userId: other }], "[]")).toThrow(/stored owner/);
    expect(() => mergeSpriteBaselines(sha, [managed], JSON.stringify([spec(other)]))).toThrow(/another scope/);
    const different = spec(other, "other", "c".repeat(40));
    expect(mergeSpriteBaselines(sha, [managed], JSON.stringify([different]))).toHaveLength(2);
  });

  it("lists diagnostics without lease tokens and only retires unassigned ready entries", async () => {
    const profile = (await getEffectiveSpriteBaselines(sha)).find((p) => p.repositoryId)!;
    const [run] = await db.insert(agentSessions).values({ userId: owner, goal: "<chat>" }).returning();
    const rows = await db.insert(spritePoolEntries).values([
      { state: "ready", runId: null }, { state: "preparing", runId: null }, { state: "claimed", runId: run.id },
    ].map((row) => ({ ...row, spriteName: crypto.randomUUID(), baselineManifest: profile.manifest,
      fingerprint: profile.fingerprint, checkpointId: "v1", leaseToken: crypto.randomUUID(), lastError: "readiness failed" }))).returning();
    const surface = await listSnapshots(ctx);
    expect(surface.profiles[0].entries).toHaveLength(2);
    expect(JSON.stringify(surface)).not.toContain(rows[0].leaseToken);
    expect(surface.profiles[0].entries[0].lastError).toBe("readiness failed");
    await expect(retireSnapshot(ctx, rows[0].id)).resolves.toMatchObject({ state: "draining" });
    await expect(retireSnapshot(ctx, rows[1].id)).rejects.toThrow(/Unused ready/);
    await expect(retireSnapshot(ctx, rows[2].id)).rejects.toThrow(/Unused ready/);
    await expect(retireSnapshot({ ...ctx, userId: other }, rows[0].id)).rejects.toThrow(/editable/);
  });

  it("serializes concurrent profile changes against the global target budget", async () => {
    await db.insert(repositories).values({ id: "R-second", name: "Second", remote: "https://github.com/acme/second" }).onConflictDoNothing();
    vi.stubEnv("TASK_ORCH_SPRITE_POOL_BASELINES", JSON.stringify([generic, { ...spec(owner), target: 0 }, { ...spec(other, "R-second", "c".repeat(40)), target: 0 }]));
    const results = await Promise.allSettled([
      setSnapshotTarget(ctx, { repoId: "R-default", target: 1 }),
      setSnapshotTarget({ author: "test", userId: other }, { repoId: "R-second", target: 1 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getEffectiveSpriteBaselines(sha)).reduce((n, p) => n + p.target, 0)).toBe(3);
  });
});
