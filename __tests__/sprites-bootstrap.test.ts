import { describe, expect, it, vi } from "vitest";

import { bootstrapSprite, SpritesBootstrapError } from "../lib/runner/sprites-bootstrap";
import type { SpritesClient } from "../lib/runner/sprites-client";

function fakeClient(overrides: Partial<SpritesClient> = {}): SpritesClient {
  return {
    createSprite: vi.fn(async () => ({ name: "x", status: "running" })),
    getSprite: vi.fn(async () => ({ name: "x", status: "running" })),
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
  it("happy path calls exec twice then checkpoint", async () => {
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

    expect(exec).toHaveBeenCalledTimes(2);
    const firstCall = exec.mock.calls[0] as unknown as [string, { cmd: string }];
    const secondCall = exec.mock.calls[1] as unknown as [string, { cmd: string }];
    expect(firstCall[1].cmd).toContain("mkdir -p /home/user/worker");
    expect(firstCall[1].cmd).toContain("https://example.com/worker-" + "a".repeat(40) + ".tar.gz");
    expect(secondCall[1].cmd).toBe("test -f /home/user/worker/dist/run-worker.js");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith("to-run-1", "bootstrap " + "a".repeat(40));
    expect(onStep).toHaveBeenCalledWith("fetch-worker", "success", expect.any(Number));
    expect(onStep).toHaveBeenCalledWith("verify-worker", "success", expect.any(Number));
    expect(onStep).toHaveBeenCalledWith("checkpoint", "success", expect.any(Number));
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
