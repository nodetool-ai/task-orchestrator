import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db";
import {
  agentMessages,
  agentSessions,
  repositories,
  runInputs,
  runnerInstances,
  spritePoolAssignments,
  spritePoolEntries,
  users,
} from "../db/schema";
import type { SpriteBaselineManifest } from "../lib/runner/sprites-baseline";
import type { SpritesClient } from "../lib/runner/sprites-client";
import { spritesPoolStore } from "../lib/runner/sprites-pool-store";
import { recycleCompletedSprite } from "../lib/runner/sprites-reuse";

const mocks = vi.hoisted(() => ({
  baselines: [] as Array<{
    fingerprint: string;
    repositoryId?: string;
    remote?: string;
    allowedUserIds?: number[];
    target: number;
    manifest: Record<string, unknown>;
  }>,
  verifyBaseline: vi.fn(async () => undefined),
}));

vi.mock("../lib/worker-bundle", () => ({ workerBundleId: async () => "a".repeat(40) }));
vi.mock("../lib/runner/sprites-managed-config", () => ({
  getEffectiveSpriteBaselines: async () => mocks.baselines,
}));
vi.mock("../lib/runner/sprites-baseline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/runner/sprites-baseline")>()),
  verifyBaseline: mocks.verifyBaseline,
}));

const baselineRevision = "1".repeat(40);
const publishedRevision = "2".repeat(40);

function fakeClient(overrides: Partial<SpritesClient> = {}): SpritesClient {
  return {
    createSprite: vi.fn(),
    getSprite: vi.fn(),
    getService: vi.fn(),
    listServices: vi.fn(async () => []),
    deleteSprite: vi.fn(),
    listSprites: vi.fn(async () => ({ sprites: [] })),
    listAllSprites: vi.fn(async () => []),
    putService: vi.fn(),
    startService: vi.fn(),
    stopService: vi.fn(),
    restartService: vi.fn(),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: publishedRevision, stderr: "" })),
    checkpoint: vi.fn(),
    listCheckpoints: vi.fn(async () => []),
    restoreCheckpoint: vi.fn(async () => undefined),
    getNetworkPolicy: vi.fn(async () => null),
    setNetworkPolicy: vi.fn(),
    getResourcesPolicy: vi.fn(async () => null),
    setResourcesPolicy: vi.fn(),
    proxyUrl: vi.fn(() => "wss://sprite.invalid"),
    ...overrides,
  } as SpritesClient;
}

async function reusableAssignment() {
  const suffix = crypto.randomUUID();
  const [owner] = await db.insert(users).values({
    email: `reuse-${suffix}@test.invalid`,
    passwordHash: "unused",
  }).returning();
  const repositoryId = `R-reuse-${suffix}`;
  await db.insert(repositories).values({
    id: repositoryId,
    name: `reuse-${suffix}`,
    remote: "https://github.com/acme/reusable.git",
  });
  const branch = `claude/reuse-${suffix}`;
  const spriteName = `pool-reuse-${suffix}`;
  const instanceId = crypto.randomUUID();
  const [run] = await db.insert(agentSessions).values({
    status: "completed",
    completedAt: new Date(),
    goal: "<implement>",
    toolsProfile: "",
    cwdStrategy: "worktree",
    branch,
    repoId: repositoryId,
    userId: owner!.id,
    workerScope: spriteName,
    sdkSessionId: "codex:durable-session",
  }).returning();
  await db.insert(runnerInstances).values({
    runId: run!.id,
    provider: "sprites",
    state: "running",
    generationState: "active",
    workerGeneration: 7,
    channelInstanceId: instanceId,
    providerOperationId: crypto.randomUUID(),
    providerServiceName: `worker-r${run!.id}-g7`,
    repoPath: `/home/user/session/runs/${run!.id}/repo`,
  });
  const manifest: SpriteBaselineManifest = {
    schemaVersion: 1,
    workerBundleSha: "a".repeat(40),
    nodeVersion: process.version,
    codexVersion: "0.153.4",
    platform: "linux",
    architecture: process.arch as "x64" | "arm64",
    systemToolsVersion: "sprite-base-v1",
    dependency: {
      repository: "https://github.com/acme/reusable.git",
      revision: baselineRevision,
      lockfile: { path: "package-lock.json", sha256: "b".repeat(64) },
      packageManifests: [{ path: "package.json", sha256: "c".repeat(64) }],
      packageManager: "npm",
      packageManagerVersion: "10.9.8",
      installOptions: ["--no-audit"],
    },
  };
  const fingerprint = `fp-${suffix}`;
  const [entry] = await db.insert(spritePoolEntries).values({
    spriteName,
    state: "ready",
    baselineClass: "repository",
    fingerprint,
    baselineManifest: manifest,
    checkpointId: "checkpoint-v1",
    restoreState: "restored",
  }).returning();
  mocks.baselines = [{
    fingerprint,
    repositoryId,
    remote: "https://github.com/acme/reusable.git",
    allowedUserIds: [owner!.id],
    target: 1,
    manifest: manifest as unknown as Record<string, unknown>,
  }];
  const claimed = await spritesPoolStore.claimForRun({
    runId: run!.id,
    fingerprint,
    expectedWorkerGeneration: 7,
    reuseAffinity: { userId: owner!.id, repositoryId },
  });
  await db.update(runnerInstances).set({ state: "running", generationState: "active" })
    .where(eq(runnerInstances.runId, run!.id));
  return {
    run: run!,
    entry: claimed!,
    owner: owner!,
    repositoryId,
    branch,
    spriteName,
    ref: { runId: run!.id, providerHandle: spriteName, generation: 7, instanceId },
  };
}

beforeEach(async () => {
  await db.delete(spritePoolAssignments);
  await db.delete(spritePoolEntries);
  await db.delete(runnerInstances);
  await db.delete(agentSessions);
  vi.stubEnv("TASK_ORCH_SPRITE_POOL_REUSE", "1");
  vi.stubEnv("GH_TOKEN", "test-github-token");
  mocks.baselines = [];
  mocks.verifyBaseline.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("completed Sprite recycling", () => {
  it("publishes a verified completed assignment as ready and revokes its old run binding", async () => {
    const fixture = await reusableAssignment();
    const service = { name: `worker-r${fixture.run.id}-g7`, cmd: "node", state: { status: "running" } };
    const listServices = vi.fn()
      .mockResolvedValueOnce([service])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const client = fakeClient({ listServices });
    const stopService = vi.fn(async () => undefined);

    await expect(recycleCompletedSprite(client, fixture.ref, stopService)).resolves.toBe(true);

    expect(stopService).toHaveBeenCalledWith(fixture.spriteName, service.name);
    expect(client.exec).toHaveBeenCalledWith(fixture.spriteName, expect.objectContaining({
      env: { GH_TOKEN: "test-github-token", GIT_TERMINAL_PROMPT: "0" },
      cmd: expect.stringContaining("https://github.com/acme/reusable.git"),
    }));
    expect(client.restoreCheckpoint).toHaveBeenCalledWith(fixture.spriteName, "checkpoint-v1");
    expect(mocks.verifyBaseline).toHaveBeenCalledWith(client, fixture.spriteName, expect.any(Object), expect.any(String));
    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "ready",
      runId: null,
      leaseToken: null,
      reuseUserId: fixture.owner.id,
      reuseRepositoryId: fixture.repositoryId,
      reuseCount: 1,
    });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, fixture.run.id)))[0]).toMatchObject({
      spriteName: null,
      state: "gone",
      generationState: "stopped",
      controllerId: null,
      channelEndpoint: null,
    });
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, fixture.run.id)))[0]).toMatchObject({
      workerScope: null,
      sdkSessionId: null,
    });
    const [assignment] = await db.select().from(spritePoolAssignments)
      .where(eq(spritePoolAssignments.runId, fixture.run.id));
    expect(assignment).toMatchObject({
      poolEntryId: fixture.entry.id,
      userId: fixture.owner.id,
      repositoryId: fixture.repositoryId,
      generation: 7,
      branch: fixture.branch,
      commitSha: publishedRevision,
    });
    expect(assignment!.releasedAt).toBeInstanceOf(Date);
  });

  it("retains a completed assignment when its checkout is dirty or unpublished", async () => {
    const fixture = await reusableAssignment();
    const client = fakeClient({
      exec: vi.fn(async () => ({ exitCode: 4, stdout: "", stderr: "branch is not published" })),
    });

    await expect(recycleCompletedSprite(client, fixture.ref, vi.fn(async () => undefined))).resolves.toBe(true);

    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "claimed",
      runId: fixture.run.id,
      reuseCount: 0,
    });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, fixture.run.id)))[0]).toMatchObject({
      spriteName: fixture.spriteName,
      state: "stopped",
      generationState: "stopped",
    });
    const [assignment] = await db.select().from(spritePoolAssignments)
      .where(eq(spritePoolAssignments.runId, fixture.run.id));
    expect(assignment).toMatchObject({ releasedAt: null, commitSha: null });
    expect(client.restoreCheckpoint).not.toHaveBeenCalled();
    expect(mocks.verifyBaseline).not.toHaveBeenCalled();
  });

  it("does not issue provider calls or release for a stale generation reference", async () => {
    const fixture = await reusableAssignment();
    const client = fakeClient();

    await expect(recycleCompletedSprite(client, { ...fixture.ref, instanceId: crypto.randomUUID() }, vi.fn()))
      .resolves.toBe(true);

    expect(client.listServices).not.toHaveBeenCalled();
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.restoreCheckpoint).not.toHaveBeenCalled();
    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "claimed",
      runId: fixture.run.id,
      reuseCount: 0,
    });
  });

  it("keeps a failed restore fenced in recycling and finishes it on retry", async () => {
    const fixture = await reusableAssignment();
    const restoreCheckpoint = vi.fn()
      .mockRejectedValueOnce(new Error("restore unavailable"))
      .mockResolvedValueOnce(undefined);
    const client = fakeClient({ restoreCheckpoint });

    await expect(recycleCompletedSprite(client, fixture.ref, vi.fn(async () => undefined)))
      .rejects.toThrow("restore unavailable");
    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "recycling",
      runId: fixture.run.id,
      reuseCount: 0,
    });
    expect((await db.select().from(runnerInstances).where(eq(runnerInstances.runId, fixture.run.id)))[0]).toMatchObject({
      spriteName: fixture.spriteName,
      state: "stopped",
      generationState: "stopping",
    });
    const [reserved] = await db.select().from(spritePoolAssignments)
      .where(eq(spritePoolAssignments.runId, fixture.run.id));
    expect(reserved).toMatchObject({ commitSha: publishedRevision, releasedAt: null });

    await expect(recycleCompletedSprite(client, fixture.ref, vi.fn(async () => undefined))).resolves.toBe(true);
    expect(restoreCheckpoint).toHaveBeenCalledTimes(2);
    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "ready",
      runId: null,
      reuseCount: 1,
    });
  });

  it("preserves a follow-up queued while checkpoint restore owns the old Sprite", async () => {
    const fixture = await reusableAssignment();
    let enterRestore!: () => void;
    let finishRestore!: () => void;
    const restoreStarted = new Promise<void>((resolve) => { enterRestore = resolve; });
    const restoreGate = new Promise<void>((resolve) => { finishRestore = resolve; });
    const client = fakeClient({
      restoreCheckpoint: vi.fn(async () => {
        enterRestore();
        await restoreGate;
      }),
    });

    const recycling = recycleCompletedSprite(client, fixture.ref, vi.fn(async () => undefined));
    await restoreStarted;
    const [message] = await db.insert(agentMessages).values({
      runId: fixture.run.id,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "continue on the published branch" }]),
    }).returning();
    const inputId = crypto.randomUUID();
    await db.insert(runInputs).values({
      id: inputId,
      runId: fixture.run.id,
      inputSeq: 1,
      messageId: message!.id,
      kind: "user",
      status: "pending",
    });
    await db.update(agentSessions).set({ status: "pending", completedAt: null })
      .where(eq(agentSessions.id, fixture.run.id));
    finishRestore();

    await expect(recycling).resolves.toBe(true);
    expect((await db.select().from(runInputs).where(eq(runInputs.id, inputId)))[0]).toMatchObject({
      runId: fixture.run.id,
      status: "pending",
      messageId: message!.id,
    });
    expect((await db.select().from(agentSessions).where(eq(agentSessions.id, fixture.run.id)))[0]).toMatchObject({
      status: "pending",
      completedAt: null,
      workerScope: null,
      sdkSessionId: null,
    });
    expect(await spritesPoolStore.findBySpriteName(fixture.spriteName)).toMatchObject({
      state: "ready",
      runId: null,
    });
  });
});
