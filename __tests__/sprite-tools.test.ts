import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { agentSessions, runnerInstances, users } from "../db/schema";
import { dispatchAppOperation, resolveOperation } from "../lib/app-api";
import { appCapabilitiesForTools, allowedServerTools } from "../lib/worker/server-policy";
import { codeActCatalogForContext } from "../lib/codeact/catalog";
import { executeAppCodeAct } from "../lib/codeact/app-bridge";
import { SPRITE_TOOLS } from "../lib/sprite-tools";
import {
  checkpointRun,
  checkpointRunStatus,
  spriteCommandStatus,
  startSpriteCommand,
} from "../lib/sprite-commands";

const sprites = vi.hoisted(() => ({
  exec: vi.fn(),
  listCheckpoints: vi.fn(),
  checkpoint: vi.fn(),
}));

vi.mock("../lib/runner/sprites-client", () => ({
  makeSpritesClient: () => sprites,
  SPRITE_CHECKPOINT_TIMEOUT_MS: 10 * 60_000,
}));

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";

type SeededRun = { runId: number; userId: number; generation: number };

async function seedRun(email: string, generation = 3): Promise<SeededRun> {
  const [user] = await db.insert(users).values({
    email: `${randomUUID()}-${email}`,
    passwordHash: "test-only",
  }).returning();
  const [run] = await db.insert(agentSessions).values({
    goal: "<implement>",
    status: "running",
    repoId: "R-default",
    userId: user.id,
  }).returning();
  await db.insert(runnerInstances).values({
    runId: run.id,
    provider: "sprites",
    spriteName: `owned-sprite-${run.id}`,
    state: "running",
    generationState: "active",
    workerGeneration: generation,
    repoPath: "/mnt/session/repo",
  });
  return { runId: run.id, userId: user.id, generation };
}

const context = (userId: number) => ({ author: "test", runtime: "server" as const, userId });

beforeEach(async () => {
  sprites.exec.mockReset().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  sprites.listCheckpoints.mockReset();
  sprites.checkpoint.mockReset();
  await db.delete(runnerInstances);
  await db.delete(agentSessions);
});

afterEach(() => vi.restoreAllMocks());

describe("Sprite operations in CodeAct", () => {
  it("catalogues the real Sprite operations only for the orchestrator profile", async () => {
    const allowed = await allowedServerTools("orchestrator");
    const denied = await allowedServerTools("repo_read");
    const allowedContext = {
      author: "test",
      runtime: "server" as const,
      capabilities: appCapabilitiesForTools(allowed),
    };

    expect(codeActCatalogForContext(allowedContext, {}, { query: "app.sprites." }).operations).toHaveLength(4);
    expect(codeActCatalogForContext(allowedContext, {}, { query: "app.snapshots." }).operations).toHaveLength(7);
    expect(codeActCatalogForContext({
      ...allowedContext,
      capabilities: appCapabilitiesForTools(denied),
    }, {}, { query: "app.sprites." }).operations).toEqual([]);

    for (const tool of SPRITE_TOOLS) {
      expect(allowed).toContain(tool.name);
      expect(denied).not.toContain(tool.name);
      expect(resolveOperation(tool.name)?.tool).toBe(tool);
    }
    await expect(dispatchAppOperation("sprites_list", {}, {
      ...allowedContext,
      capabilities: [],
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("dispatches an owned Sprite listing through the CodeAct guest", async () => {
    const owned = await seedRun("codeact@example.com");
    await seedRun("someone-else@example.com");
    const capabilities = appCapabilitiesForTools(await allowedServerTools("orchestrator"));

    const result = await executeAppCodeAct({
      context: { ...context(owned.userId), capabilities },
      code: "const result = await app.sprites.list({}); return JSON.parse(result.content[0].text);",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.value).toEqual([expect.objectContaining({
      runId: owned.runId,
      generation: owned.generation,
      state: "running",
      generationState: "active",
      repoId: "R-default",
      directory: "/mnt/session/repo",
    })]);
  });
});

describe("owned Sprite checkpoints", () => {
  it("submits asynchronously and exposes completion through checkpointStatus", async () => {
    const owned = await seedRun("checkpoint@example.com");
    let release!: (value: { id: string; comment: string }) => void;
    sprites.listCheckpoints.mockResolvedValue([]);
    sprites.checkpoint.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const input = { runId: owned.runId, generation: owned.generation,
      operationId: "22222222-2222-4222-8222-222222222222", comment: "recover me" };

    await expect(checkpointRun(context(owned.userId), input)).resolves.toMatchObject({ status: "submitted" });
    expect(sprites.checkpoint).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sprites.checkpoint).toHaveBeenCalledTimes(1));
    const providerComment = sprites.checkpoint.mock.calls[0][1];
    release({ id: "checkpoint-7", comment: providerComment });
    await vi.waitFor(async () => expect(await checkpointRunStatus(context(owned.userId), input))
      .toMatchObject({ status: "completed", checkpointId: "checkpoint-7" }));
  });

  it("does not launch a duplicate for a repeated operation ID", async () => {
    const owned = await seedRun("checkpoint-repeat@example.com");
    sprites.listCheckpoints.mockResolvedValue([]);
    sprites.checkpoint.mockResolvedValue({ id: "checkpoint-8" });
    const input = { runId: owned.runId, generation: owned.generation,
      operationId: "33333333-3333-4333-8333-333333333333", comment: "once" };

    await checkpointRun(context(owned.userId), input);
    await vi.waitFor(async () => expect(await checkpointRunStatus(context(owned.userId), input))
      .toMatchObject({ status: "completed" }));
    await checkpointRun(context(owned.userId), input);
    expect(sprites.checkpoint).toHaveBeenCalledTimes(1);
  });

  it("persists detailed redacted provider failures for inspection", async () => {
    const owned = await seedRun("checkpoint-error@example.com");
    sprites.listCheckpoints.mockResolvedValue([]);
    sprites.checkpoint.mockRejectedValue(Object.assign(
      new Error("Sprites API error 507: disk full token=super-secret-value"), { status: 507 },
    ));
    const input = { runId: owned.runId, generation: owned.generation,
      operationId: "44444444-4444-4444-8444-444444444444" };

    await checkpointRun(context(owned.userId), input);
    await vi.waitFor(async () => expect(await checkpointRunStatus(context(owned.userId), input))
      .toMatchObject({ status: "failed", retryable: true }));
    const status = await checkpointRunStatus(context(owned.userId), input);
    expect(status.error).toContain("HTTP 507");
    expect(status.error).toContain("disk full");
    expect(status.error).not.toContain("super-secret-value");
  });
});

describe("owned Sprite commands", () => {
  it("rejects another owner and a stale generation before calling the provider", async () => {
    const owned = await seedRun("owner@example.com");
    const other = await seedRun("other@example.com");
    const input = {
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
      command: "pwd",
    };

    await expect(startSpriteCommand(context(other.userId), input)).rejects.toThrow(/not owned/);
    await expect(startSpriteCommand(context(owned.userId), {
      ...input,
      generation: owned.generation + 1,
    })).rejects.toThrow(/generation is unavailable or changed/);
    expect(sprites.exec).not.toHaveBeenCalled();
  });

  it("uses the persisted run owner instead of a spoofed context user", async () => {
    const owned = await seedRun("persisted-owner@example.com");
    const other = await seedRun("spoofed-owner@example.com");

    await expect(startSpriteCommand({
      ...context(other.userId),
      runId: owned.runId,
    }, {
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
      command: "pwd",
    })).resolves.toMatchObject({ commandId: COMMAND_ID, status: "submitted" });
    expect(sprites.exec).toHaveBeenCalledTimes(1);
  });

  it("launches retries at the same guarded path and shell-quotes the directory", async () => {
    const owned = await seedRun("launch@example.com");
    const input = {
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
      command: "printf '%s' \"$HOME;still-data\"",
      directory: "/tmp/work dir/it's-safe",
      timeoutSeconds: 42,
    };

    const first = await startSpriteCommand(context(owned.userId), input);
    const second = await startSpriteCommand(context(owned.userId), input);

    expect(first).toEqual(second);
    expect(first).toEqual({
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
      status: "submitted",
      timeoutSeconds: 42,
    });
    expect(sprites.exec).toHaveBeenCalledTimes(2);
    const calls = sprites.exec.mock.calls.map((call) => call[1]);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ maxOutputBytes: 64_000, timeoutMs: 10_000 });
    expect(calls[0].cmd).toContain(`/var/tmp/task-orch-codeact/r${owned.runId}/g${owned.generation}/${COMMAND_ID}`);
    expect(calls[0].cmd).toContain("if mkdir ");
    expect(calls[0].cmd).toContain("/tmp/work dir/it");
    expect(calls[0].cmd).toContain("'\\''s-safe");
    expect(calls[0].cmd).toContain("timeout --signal=TERM --kill-after=5s 42s sh -c");
  });

  it("returns structured command status and bounded output metadata", async () => {
    const owned = await seedRun("status@example.com");
    sprites.exec.mockResolvedValue({
      stdout: "exited 7\nlast stdout bytes",
      stderr: "last stderr bytes",
      exitCode: 0,
    });

    const result = await spriteCommandStatus(context(owned.userId), {
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
    });

    expect(result).toMatchObject({
      runId: owned.runId,
      generation: owned.generation,
      commandId: COMMAND_ID,
      status: "exited",
      exitCode: 7,
      stdout: "last stdout bytes",
      stderr: "last stderr bytes",
    });
    expect(result.output).toMatch(/16000 bytes per stream/);
    expect(sprites.exec).toHaveBeenCalledWith(`owned-sprite-${owned.runId}`, expect.objectContaining({
      maxOutputBytes: 64_000,
      timeoutMs: 10_000,
    }));
  });

  it("requires a stable UUID before dispatching a command", async () => {
    const owned = await seedRun("uuid@example.com");
    const capabilities = appCapabilitiesForTools(await allowedServerTools("orchestrator"));

    await expect(dispatchAppOperation("sprites_startCommand", {
      runId: owned.runId,
      generation: owned.generation,
      command: "pwd",
    }, { ...context(owned.userId), capabilities })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(startSpriteCommand(context(owned.userId), {
      runId: owned.runId,
      generation: owned.generation,
      commandId: "not-a-uuid",
      command: "pwd",
    })).rejects.toThrow();
    expect(sprites.exec).not.toHaveBeenCalled();
  });
});
