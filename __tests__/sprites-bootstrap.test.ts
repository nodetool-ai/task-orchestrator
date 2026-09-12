import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapSprite,
  configureSpriteSwap,
  SPRITE_NODE_VERSION,
  spriteNodeSetupCommand,
  spriteSwapSetupCommand,
  SpritesBootstrapError,
} from "../lib/runner/sprites-bootstrap";
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

const swapRoots: string[] = [];

async function executable(path: string, source: string) {
  await writeFile(path, `#!/bin/sh\n${source}\n`);
  await chmod(path, 0o755);
}

async function swapShellFixture(size: number, active = false) {
  const root = await mkdtemp(join(tmpdir(), "sprite-swap-shell-"));
  swapRoots.push(root);
  const bin = join(root, "bin");
  const swapFile = join(root, "task-orchestrator.swap");
  const swaps = join(root, "proc-swaps");
  const log = join(root, "calls.log");
  await mkdir(bin);
  await writeFile(swapFile, Buffer.alloc(size));
  await writeFile(swaps, `Filename\tType\tSize\tUsed\tPriority\n${active ? "/task-orchestrator.swap file 1024 0 -2\n" : ""}`);
  await executable(join(bin, "flock"), 'printf "flock %s\\n" "$*" >> "$MOCK_CALL_LOG"');
  await executable(join(bin, "findmnt"), 'printf "%s\\n" "$MOCK_MOUNT_TARGET"');
  await executable(join(bin, "stat"), '[ -f "$3" ] || exit 1\nwc -c < "$3" | tr -d " "');
  await executable(join(bin, "sudo"), '[ "$1" = -n ] && shift\nexec "$@"');
  await executable(join(bin, "swapoff"), 'printf "swapoff %s\\n" "$*" >> "$MOCK_CALL_LOG"\n[ "${MOCK_SWAPOFF_FAIL:-0}" = 1 ] && exit 1\nexit 0');
  await executable(join(bin, "swapon"), [
    'printf "swapon %s\\n" "$*" >> "$MOCK_CALL_LOG"',
    'if [ "${MOCK_SWAPON_MODE:-success}" = busy-active ]; then',
    '  printf "/task-orchestrator.swap file 1024 0 -2\\n" >> "$MOCK_PROC_SWAPS"',
    '  exit 1',
    "fi",
    '[ "${MOCK_SWAPON_MODE:-success}" = fail ] && exit 1',
    'printf "/task-orchestrator.swap file 1024 0 -2\\n" >> "$MOCK_PROC_SWAPS"',
  ].join("\n"));
  await executable(join(bin, "mkswap"), "exit 0");
  const command = spriteSwapSetupCommand(1)
    .replaceAll("/tmp/task-orchestrator.swap", swapFile)
    .replaceAll("/proc/swaps", swaps);
  const run = (env: Record<string, string> = {}) => new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`,
      MOCK_CALL_LOG: log, MOCK_MOUNT_TARGET: root, MOCK_PROC_SWAPS: swaps, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  return { swapFile, swaps, log, run };
}

afterEach(async () => {
  await Promise.all(swapRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bootstrapSprite", () => {
  it("creates and verifies disk-backed swap idempotently", async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const client = fakeClient({ exec });

    await configureSpriteSwap(client, "fixture", 4096);

    expect(exec).toHaveBeenCalledWith("fixture", {
      cmd: spriteSwapSetupCommand(4096),
      timeoutMs: 600_000,
    });
    const command = (exec.mock.calls[0] as unknown as [string, { cmd: string }])[1].cmd;
    expect(command).toContain('dd if=/dev/zero of="$swap_file"');
    expect(command).toContain("mkswap");
    expect(command).toContain("swapon");
    expect(() => spriteSwapSetupCommand(0)).toThrow("positive integer");
  });

  it("surfaces swap activation failures", async () => {
    const client = fakeClient({ exec: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "swapon: denied" })) });
    await expect(configureSpriteSwap(client, "fixture", 4096)).rejects.toMatchObject({
      step: "configure-swap",
      message: expect.stringContaining("swapon: denied"),
    });
  });

  it("recognizes the active swap path reported relative to the /tmp mount", async () => {
    const fixture = await swapShellFixture(1024 * 1024, true);
    expect(await fixture.run()).toMatchObject({ code: 0 });
    expect(await readFile(fixture.log, "utf8")).toBe("flock -x 9\n");
  });

  it("does not delete an active swap file when swapoff fails during resize", async () => {
    const fixture = await swapShellFixture(17, true);
    const before = await readFile(fixture.swapFile);
    const result = await fixture.run({ MOCK_SWAPOFF_FAIL: "1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("swapoff failed");
    expect(await readFile(fixture.swapFile)).toEqual(before);
    expect(await readFile(fixture.log, "utf8")).toContain("swapoff");
  });

  it("accepts a failed swapon only when a recheck finds the expected mount alias active", async () => {
    const raced = await swapShellFixture(1024 * 1024);
    expect(await raced.run({ MOCK_SWAPON_MODE: "busy-active" })).toMatchObject({ code: 0 });

    const failed = await swapShellFixture(1024 * 1024);
    const result = await failed.run({ MOCK_SWAPON_MODE: "fail" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("expected swap is not active");
  });

  it("selects Node before npm and invalidates checkpoints from the floating runtime", async () => {
    const client = fakeClient({ listCheckpoints: vi.fn(async () => [{ id: "old", comment: `bootstrap ${"a".repeat(40)}` }]) });
    await bootstrapSprite(client, "fixture", { workerSha: "a".repeat(40), bundleUrl: "https://example.com/worker.tgz" });
    const commands = vi.mocked(client.exec).mock.calls.map((call) => call[1].cmd);
    expect(commands[1]).toBe(spriteNodeSetupCommand());
    expect(commands[2]).toContain("npm install");
    expect(client.checkpoint).toHaveBeenCalledWith("fixture", `bootstrap ${"a".repeat(40)} node ${SPRITE_NODE_VERSION}`);
  });

  it("honors baseline runtime versions and rejects non-exact versions before exec", async () => {
    const client = fakeClient();
    const opts = { workerSha: "a".repeat(40), bundleUrl: "https://example.com/worker.tgz", nodeVersion: "v22.14.0" };
    await bootstrapSprite(client, "fixture", opts);
    expect(vi.mocked(client.exec).mock.calls[1][1].cmd).toBe(spriteNodeSetupCommand(opts.nodeVersion));
    const invalid = fakeClient();
    await expect(bootstrapSprite(invalid, "fixture", { ...opts, nodeVersion: "22; exit 0" })).rejects.toThrow("exact");
    expect(invalid.exec).not.toHaveBeenCalled();
  });

  it("does not install Codex or seal a checkpoint after runtime setup fails", async () => {
    const client = fakeClient({ exec: vi.fn(async (_name, input) => input.cmd.includes("nvm.sh")
      ? { exitCode: 1, stdout: "", stderr: "Node download failed" }
      : { exitCode: 0, stdout: "", stderr: "" }) });
    await expect(bootstrapSprite(client, "fixture", { workerSha: "a".repeat(40), bundleUrl: "https://example.com/worker.tgz" }))
      .rejects.toMatchObject({ step: "install-node", message: expect.stringContaining("Node download failed") });
    expect(client.exec).toHaveBeenCalledTimes(2);
    expect(client.checkpoint).not.toHaveBeenCalled();
  });

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

    expect(exec).toHaveBeenCalledTimes(4);
    const firstCall = exec.mock.calls[0] as unknown as [string, { cmd: string }];
    const secondCall = exec.mock.calls[2] as unknown as [string, { cmd: string; timeoutMs?: number }];
    const thirdCall = exec.mock.calls[3] as unknown as [string, { cmd: string }];
    expect(firstCall[1].cmd).toContain("mkdir -p /home/user/worker");
    expect(firstCall[1].cmd).toContain("https://example.com/worker-" + "a".repeat(40) + ".tar.gz");
    expect(secondCall[1].cmd).toContain("@openai/codex@0.153.4");
    expect(secondCall[1].timeoutMs).toBe(600_000);
    expect(thirdCall[1].cmd).toContain("'/home/user/worker/.codex/bin/codex' --version");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledWith("to-run-1", `bootstrap ${"a".repeat(40)} node ${SPRITE_NODE_VERSION}`);
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
    expect(exec).toHaveBeenCalledTimes(3);
    expect((exec.mock.calls[2] as any)[1].cmd).toContain("'/opt/codex/bin/codex' --version");
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
    const listCheckpoints = vi.fn(async () => [{ id: "v99", comment: `bootstrap ${sha} node ${SPRITE_NODE_VERSION}`, createdAt: new Date() }]);
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
