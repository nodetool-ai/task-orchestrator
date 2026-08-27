import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { agentSessions, runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { isRunSpriteName, SpritesRunnerProvider, spriteNameForRun, spritesRunnerStateFromStatus } from "../lib/runner/sprites";
import { SpritesApiError } from "../lib/runner/sprites-client";
import type { SpritesClient } from "../lib/runner/sprites-client";

function fakeSpritesClient(overrides: Partial<SpritesClient> = {}): SpritesClient & { _calls: string[] } {
  const calls: string[] = [];
  const base: SpritesClient = {
    createSprite: vi.fn(async (input: { name: string }) => {
      calls.push(`createSprite:${input.name}`);
      return { name: input.name, status: "running" };
    }),
    getSprite: vi.fn(async (name: string) => {
      calls.push(`getSprite:${name}`);
      return { name, status: "running" };
    }),
    deleteSprite: vi.fn(async (name: string) => {
      calls.push(`deleteSprite:${name}`);
    }),
    listSprites: vi.fn(async () => ({ sprites: [], continuationToken: undefined })),
    listAllSprites: vi.fn(async () => []),
    putService: vi.fn(async () => {
      calls.push("putService");
    }),
    startService: vi.fn(async () => {
      calls.push("startService");
    }),
    deleteService: vi.fn(async () => {
      calls.push("deleteService");
    }),
    stopService: vi.fn(async () => {
      calls.push("stopService");
    }),
    restartService: vi.fn(async () => {}),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(async () => ({ id: "cp1" })),
    listCheckpoints: vi.fn(async () => []),
    restoreCheckpoint: vi.fn(async () => {}),
    getNetworkPolicy: vi.fn(async () => null),
    setNetworkPolicy: vi.fn(async () => {
      calls.push("setNetworkPolicy");
    }),
    getResourcesPolicy: vi.fn(async () => null),
    setResourcesPolicy: vi.fn(async () => {}),
    proxyUrl: vi.fn((name: string) => `wss://api.sprites.dev/v1/sprites/${name}/proxy`),
    ...overrides,
  } as SpritesClient;
  (base as unknown as { _calls: string[] })._calls = calls;
  return base as SpritesClient & { _calls: string[] };
}

beforeEach(async () => {
  await db.delete(agentSessions);
  vi.stubEnv("SPRITES_TOKEN", "test-token");
  vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://example.com/worker-{sha}.tar.gz");
  vi.stubEnv("TASK_ORCH_WORKER_SHA", "a".repeat(40));
});

afterEach(async () => {
  await db.delete(agentSessions);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("spritesRunnerStateFromStatus", () => {
  it("maps known statuses", () => {
    expect(spritesRunnerStateFromStatus("running")).toBe("running");
    expect(spritesRunnerStateFromStatus("warm")).toBe("starting");
    expect(spritesRunnerStateFromStatus("cold")).toBe("suspended");
    expect(spritesRunnerStateFromStatus("destroyed")).toBe("gone");
    expect(spritesRunnerStateFromStatus("unknown_status_xyz")).toBe("starting");
  });
});

describe("SpritesRunnerProvider.create", () => {
  it("inserts row with provider sprites and sprite:// endpoint", async () => {
    const client = fakeSpritesClient();
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    const ref = await provider.create({ runId: run.id, scope: `run-${run.id}` });

    expect(ref?.handle).toBe(spriteNameForRun(run.id));
    expect(ref?.provider).toBe("sprites");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.provider).toBe("sprites");
    expect(row.spriteName).toBe(spriteNameForRun(run.id));
    expect(row.channelEndpoint).toBe(`sprite://${spriteNameForRun(run.id)}:8787/worker/channel`);
    expect(row.state).toBe("starting");
    expect(client.createSprite).toHaveBeenCalled();
    expect(client.putService).toHaveBeenCalled();
    expect(client.startService).toHaveBeenCalled();
  });

  it("proceeds without deleteSprite when createSprite throws 409", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      createSprite: vi.fn(async () => {
        throw new SpritesApiError(409, "already exists");
      }),
      deleteSprite: deleteSpy,
      putService: vi.fn(async () => {}),
      startService: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    const ref = await provider.create({ runId: run.id, scope: `run-${run.id}` });

    expect(ref?.handle).toBe(spriteNameForRun(run.id));
    expect(deleteSpy).not.toHaveBeenCalled();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row).toBeTruthy();
  });

  it("calls deleteSprite once and rethrows when putService throws", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      createSprite: vi.fn(async (input) => ({ name: input.name, status: "running" })),
      putService: vi.fn(async () => {
        throw new Error("putService failed");
      }),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });

    await expect(provider.create({ runId: run.id, scope: `run-${run.id}` })).rejects.toThrow("putService failed");
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(spriteNameForRun(run.id));
    // Row should not exist after failed create (rolled back? Actually insert happens after putService, so no row)
    const rows = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(rows).toHaveLength(0);
  });
});

describe("SpritesRunnerProvider.resume", () => {
  it("on cold sprite sets row state to starting and calls startService once", async () => {
    const startSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold" })),
      startService: startSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "suspended",
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      channelEndpoint: `sprite://${spriteName}:8787/worker/channel`,
    });

    const ref = await provider.resume(run.id);

    expect(ref?.handle).toBe(spriteName);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(spriteName, "worker");
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("starting");
  });

  it("when getSprite returns null marks row gone and returns null", async () => {
    const client = fakeSpritesClient({
      getSprite: vi.fn(async () => null),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    const ref = await provider.resume(run.id);

    expect(ref).toBeNull();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
  });
});

describe("SpritesRunnerProvider.stop", () => {
  it("calls deleteSprite, clears workerScope only when it equals sprite name, nulls sdkSessionId", async () => {
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({ deleteSprite: deleteSpy });
    const provider = new SpritesRunnerProvider(client);

    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.update(agentSessions)
      .set({ workerScope: spriteName, sdkSessionId: "sdk-keep-me", status: "running" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    await provider.stop(spriteName);

    expect(deleteSpy).toHaveBeenCalledWith(spriteName);
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.workerScope).toBeNull();
    expect(session.sdkSessionId).toBeNull();
    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    expect(row.state).toBe("gone");
    expect(row.spriteName).toBeNull();
  });

  it("does not clear workerScope when it does not equal sprite name", async () => {
    const client = fakeSpritesClient();
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    const spriteName = spriteNameForRun(run.id);
    await db.update(agentSessions)
      .set({ workerScope: "other-scope", sdkSessionId: "sdk-123", status: "running" })
      .where(eq(agentSessions.id, run.id));
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName,
      state: "running",
    });

    await provider.stop(spriteName);

    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, run.id));
    expect(session.workerScope).toBe("other-scope");
    expect(session.sdkSessionId).toBeNull();
  });

  it("logs warn and returns when no row matches sprite name", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const deleteSpy = vi.fn(async () => {});
    const client = fakeSpritesClient({ deleteSprite: deleteSpy });
    const provider = new SpritesRunnerProvider(client);

    await provider.stop("to-run-9999");

    expect(deleteSpy).toHaveBeenCalledWith("to-run-9999");
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("isRunSpriteName", () => {
  it("matches only prefix + digits", () => {
    expect(isRunSpriteName("to-run-42")).toBe(true);
    expect(isRunSpriteName("to-run-pool-1")).toBe(false);
    expect(isRunSpriteName("to-run-42x")).toBe(false);
    expect(isRunSpriteName("other-42")).toBe(false);
  });

  it("respects custom prefix", () => {
    vi.stubEnv("TASK_ORCH_SPRITE_PREFIX", "custom-");
    expect(isRunSpriteName("custom-123")).toBe(true);
    expect(isRunSpriteName("custom-pool-1")).toBe(false);
    expect(isRunSpriteName("to-run-42")).toBe(false);
  });
});

describe("SpritesRunnerProvider sweep orphan reaper", () => {
  it("deletes only old unprotected run sprites, skips pool and null createdAt", async () => {
    const deleteSpy = vi.fn(async () => {});
    const old = new Date(Date.now() - 20 * 60_000); // 20m old, past 10m grace
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [
        { name: "to-run-99", status: "running", createdAt: old },
        { name: "to-run-pool-1", status: "running", createdAt: old },
        { name: "to-run-7", status: "running", createdAt: null },
      ]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);

    // No runner rows → protectedNames empty
    await provider.sweep();

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("to-run-99");
  });

  it("respects orphanGraceMs config", async () => {
    vi.stubEnv("TASK_ORCH_SPRITES_ORPHAN_GRACE_MS", String(60 * 60_000)); // 1h
    const deleteSpy = vi.fn(async () => {});
    const old20m = new Date(Date.now() - 20 * 60_000);
    const old2h = new Date(Date.now() - 2 * 60 * 60_000);
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [
        { name: "to-run-10", status: "running", createdAt: old20m },
        { name: "to-run-11", status: "running", createdAt: old2h },
      ]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);

    await provider.sweep();

    // 20m is within 1h grace → not deleted; 2h is past → deleted
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith("to-run-11");
  });

  it("does not reap protected sprite even if orphan-aged", async () => {
    const deleteSpy = vi.fn(async () => {});
    const old = new Date(Date.now() - 20 * 60_000);
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [{ name: "to-run-55", status: "running", createdAt: old }]),
      deleteSprite: deleteSpy,
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    // Protect to-run-55 via runnerInstances row
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-55",
      state: "running",
    });

    await provider.sweep();

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("does not corrupt row when list omits status (skips state reconciliation)", async () => {
    const getSpriteSpy = vi.fn(async (name: string) => null as unknown as { name: string; status: string } | null);
    const client = fakeSpritesClient({
      // List returns minimal entry without status (docs shape)
      listAllSprites: vi.fn(async () => [{ name: "to-run-77" } as unknown as { name: string; status: string; createdAt: Date }]),
      getSprite: getSpriteSpy,
      deleteSprite: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-77",
      state: "running",
      channelInstanceId: "wi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    // Also set agentSessions to idle so lifecycle would otherwise destroy
    await db.update(agentSessions).set({ status: "idle" }).where(eq(agentSessions.id, run.id));

    await provider.sweep();

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    // Should NOT have been corrupted to starting; should stay running because sweep skipped
    expect(row.state).toBe("running");
    expect(getSpriteSpy).toHaveBeenCalledWith("to-run-77");
  });

  it("fetches full sprite when list omits status and reconciles correctly", async () => {
    const client = fakeSpritesClient({
      listAllSprites: vi.fn(async () => [{ name: "to-run-78" } as unknown as { name: string; status: string; createdAt: Date }]),
      getSprite: vi.fn(async (name: string) => ({ name, status: "cold", createdAt: new Date() })),
      deleteSprite: vi.fn(async () => {}),
    });
    const provider = new SpritesRunnerProvider(client);
    const run = await create({ goal: "<implement>", defer: true });
    await db.insert(runnerInstances).values({
      runId: run.id,
      provider: "sprites",
      spriteName: "to-run-78",
      state: "running",
    });

    await provider.sweep();

    const [row] = await db.select().from(runnerInstances).where(eq(runnerInstances.runId, run.id));
    // cold -> suspended, so row should be updated to suspended
    expect(row.state).toBe("suspended");
  });
});
