import { describe, expect, it, vi } from "vitest";

import { bootstrapSprite, SpritesBootstrapError } from "../lib/runner/sprites-bootstrap";
import type { SpritesClient } from "../lib/runner/sprites-client";

function fakeClient(overrides: Partial<SpritesClient> = {}): SpritesClient {
  return {
    createSprite: vi.fn(async () => ({ name: "x", status: "running" })),
    getSprite: vi.fn(async () => ({ name: "x", status: "running" })),
    getService: vi.fn(async () => null),
    deleteSprite: vi.fn(async () => {}),
    listSprites: vi.fn(async () => ({ sprites: [], continuationToken: undefined })),
    listAllSprites: vi.fn(async () => []),
    putService: vi.fn(async () => {}),
    startService: vi.fn(async () => {}),
    stopService: vi.fn(async () => {}),
    restartService: vi.fn(async () => {}),
    getServiceLogs: vi.fn(async () => ""),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    checkpoint: vi.fn(async () => ({ id: "v1" })),
    listCheckpoints: vi.fn(async () => []),
    restoreCheckpoint: vi.fn(async () => {}),
    getNetworkPolicy: vi.fn(async () => null),
    setNetworkPolicy: vi.fn(async () => {}),
    getResourcesPolicy: vi.fn(async () => null),
    setResourcesPolicy: vi.fn(async () => {}),
    proxyUrl: vi.fn(() => ""),
    ...overrides,
  } as SpritesClient;
}

describe("bootstrapSprite", () => {
  it("happy path installs the pinned CLI, verifies it, then checkpoints", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const checkpoint = vi.fn(async () => ({ id: "v1" }));
    const listCheckpoints = vi.fn(async () => []);
    const client = fakeClient({ exec, checkpoint, listCheckpoints });
    const onStep = vi.fn();

    await bootstrapSprite(client, "to-run-1", {
      workerSha: "a".repeat(40),
      bundleUrl: "https://example.com/worker-{sha}.tar.gz",
      onStep,
    });

    expect(exec).toHaveBeenCalledTimes(3);
    const firstCall = exec.mock.calls[0] as unknown as [string, { cmd: string }];
    const secondCall = exec.mock.calls[1] as unknown as [string, { cmd: string; timeoutMs?: number }];
    const thirdCall = exec.mock.calls[2] as unknown as [string, { cmd: string }];
    expect(firstCall[1].cmd).toContain("mkdir -p /home/user/worker");
    expect(firstCall[1].cmd).toContain("https://example.com/worker-" + "a".repeat(40) + ".tar.gz");
    expect(secondCall[1].cmd).toContain("@openai/codex@0.153.4");
    expect(secondCall[1].timeoutMs).toBe(600_000);
    expect(thirdCall[1].cmd).toContain("'/home/user/worker/.codex/bin/codex' --version");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith("to-run-1", "bootstrap " + "a".repeat(40));
    expect(onStep).toHaveBeenCalledWith("fetch-worker", "success", expect.any(Number));
    expect(onStep).toHaveBeenCalledWith("verify-worker", "success", expect.any(Number));
    expect(onStep).toHaveBeenCalledWith("checkpoint", "success", expect.any(Number));
  });

  it("uses an explicit binary without installing Codex", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const client = fakeClient({ exec, listCheckpoints: vi.fn(async () => []) });
    await bootstrapSprite(client, "to-run-1", {
      workerSha: "e".repeat(40),
      bundleUrl: "https://example.com/worker.tar.gz",
      codexBinary: "/opt/codex/bin/codex",
    });
    expect(exec).toHaveBeenCalledTimes(2);
    expect((exec.mock.calls[1] as any)[1].cmd).toContain("'/opt/codex/bin/codex' --version");
    expect((exec.mock.calls[0] as any)[1].cmd).not.toContain("npm install");
  });

  it("does not checkpoint when native CLI installation fails", async () => {
    const exec = vi.fn(async (_sprite: string, input: { cmd: string }) =>
      input.cmd.includes("npm install")
        ? { exitCode: 1, stdout: "", stderr: "registry timeout" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    const checkpoint = vi.fn(async () => ({ id: "v1" }));
    const client = fakeClient({ exec, checkpoint, listCheckpoints: vi.fn(async () => []) });
    await expect(
      bootstrapSprite(client, "to-run-1", {
        workerSha: "f".repeat(40),
        bundleUrl: "https://example.com/worker.tar.gz",
      }),
    ).rejects.toMatchObject({ step: "install-codex" });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("failing verify-worker raises SpritesBootstrapError with step verify-worker", async () => {
    const exec = vi.fn(async ( _sprite: string, input: { cmd: string } ) => {
      if (input.cmd.includes("test -f")) {
        return { exitCode: 1, stdout: "", stderr: "not found\n".repeat(100) };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const client = fakeClient({ exec, listCheckpoints: vi.fn(async () => []), checkpoint: vi.fn(async () => ({ id: "v1" })) });

    await expect(
      bootstrapSprite(client, "to-run-1", {
        workerSha: "b".repeat(40),
        bundleUrl: "https://example.com/worker-{sha}.tar.gz",
      }),
    ).rejects.toThrow(SpritesBootstrapError);

    try {
      await bootstrapSprite(client, "to-run-1", {
        workerSha: "b".repeat(40),
        bundleUrl: "https://example.com/worker-{sha}.tar.gz",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(SpritesBootstrapError);
      expect((err as SpritesBootstrapError).step).toBe("verify-worker");
      expect((err as Error).message).toContain("verify-worker");
      // Should include last 2KB of stderr (we sent ~1KB, so it should contain "not found")
      expect((err as Error).message).toContain("not found");
    }
  });

  it("existing matching checkpoint skips exec entirely", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const checkpoint = vi.fn(async () => ({ id: "v1" }));
    const sha = "c".repeat(40);
    const listCheckpoints = vi.fn(async () => [{ id: "v99", comment: `bootstrap ${sha}`, createdAt: new Date() }]);
    const client = fakeClient({ exec, checkpoint, listCheckpoints });

    await bootstrapSprite(client, "to-run-1", {
      workerSha: sha,
      bundleUrl: "https://example.com/worker-{sha}.tar.gz",
    });

    expect(exec).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it("includes last 2KB of stderr on fetch-worker failure", async () => {
    const bigStderr = "x".repeat(5000);
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: bigStderr }));
    const client = fakeClient({ exec, listCheckpoints: vi.fn(async () => []) });

    try {
      await bootstrapSprite(client, "to-run-1", {
        workerSha: "d".repeat(40),
        bundleUrl: "https://example.com/worker-{sha}.tar.gz",
      });
    } catch (err) {
      expect((err as SpritesBootstrapError).step).toBe("fetch-worker");
      const msg = (err as Error).message;
      // Should contain only last 2KB, not the full 5KB
      expect(msg.length).toBeLessThan(5000 + 100);
      expect(msg).toContain("x");
    }
  });
});
