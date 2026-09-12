import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runner: { spriteName: "local-test-sprite", repoPath: "" },
  exec: vi.fn(),
}));

vi.mock("@/lib/sprite-access", () => ({
  spriteCaller: vi.fn(async () => ({ userId: 1, repoId: "repo-1" })),
  withOwnedSprite: vi.fn(async (_ctx, _target, action) => action(mocks.runner)),
}));

vi.mock("@/lib/runner/sprites-client", () => ({
  makeSpritesClient: () => ({ exec: mocks.exec }),
}));

import {
  execSpriteCommand,
  spriteCommandStatus,
  startSpriteCommand,
} from "@/lib/sprite-commands";

const FIXED_JOB_ROOT = "/var/tmp/task-orch-codeact/";
const RUN_ID = 41;
const GENERATION = 3;
const context = { runId: RUN_ID, author: "test" };
let root = "";

async function runShell(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const rewritten = command.replaceAll(FIXED_JOB_ROOT, `${root}/jobs/`);
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", rewritten], {
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      exitCode: code ?? (signal ? 128 : 1),
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function waitForExit(commandId: string, runId = RUN_ID) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const status = await spriteCommandStatus({ ...context, runId }, { runId, generation: GENERATION, commandId });
    if (status.status === "exited") return status;
    if (Date.now() >= deadline) throw new Error(`command ${commandId} did not exit: ${status.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sprite-command-shell-"));
  mocks.runner.repoPath = root;
  mocks.exec.mockImplementation(async (_spriteName: string, input: { cmd: string }) => runShell(input.cmd));
});

afterEach(async () => {
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("Sprite remote command shell protocol", () => {
  it("preserves apostrophes and reports stdout, stderr, and the command exit code", async () => {
    const result = await execSpriteCommand(context, {
      runId: RUN_ID,
      generation: GENERATION,
      commandId: "10000000-0000-4000-8000-000000000001",
      command: `printf "it's stdout"; printf "error's stderr" >&2; exit 7`,
      timeoutSeconds: 3,
    });

    expect(result).toMatchObject({ status: "exited", exitCode: 7 });
    expect(result.stdout).toBe("it's stdout");
    expect(result.stderr).toBe("error's stderr");
  });

  it("runs a stable UUID once and rejects the same UUID for different input", async () => {
    const commandId = "10000000-0000-4000-8000-000000000002";
    const counter = join(root, "count.txt");
    const input = {
      runId: RUN_ID,
      generation: GENERATION,
      commandId,
      command: `printf x >> '${counter}'`,
      timeoutSeconds: 3,
    };

    await startSpriteCommand(context, input);
    await waitForExit(commandId);
    await startSpriteCommand(context, input);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readFile(counter, "utf8")).toBe("x");

    await expect(startSpriteCommand(context, { ...input, command: `printf y >> '${counter}'` }))
      .rejects.toThrow("Command ID is already reserved for different input or an incomplete launch");
    expect(await readFile(counter, "utf8")).toBe("x");
  });

  it("scopes the same generation and command UUID to its run", async () => {
    const commandId = "10000000-0000-4000-8000-000000000004";
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    await startSpriteCommand(context, {
      runId: RUN_ID, generation: GENERATION, commandId,
      command: `printf first > '${first}'`, timeoutSeconds: 3,
    });
    await waitForExit(commandId);

    const secondRunId = RUN_ID + 1;
    await startSpriteCommand({ ...context, runId: secondRunId }, {
      runId: secondRunId, generation: GENERATION, commandId,
      command: `printf second > '${second}'`, timeoutSeconds: 3,
    });
    await waitForExit(commandId, secondRunId);

    expect(await readFile(first, "utf8")).toBe("first");
    expect(await readFile(second, "utf8")).toBe("second");
  });

  it("terminates a timed command and records exit code 124", async () => {
    const commandId = "10000000-0000-4000-8000-000000000003";
    await startSpriteCommand(context, {
      runId: RUN_ID,
      generation: GENERATION,
      commandId,
      command: "sleep 10",
      timeoutSeconds: 1,
    });

    const result = await waitForExit(commandId);
    expect(result).toMatchObject({ status: "exited", exitCode: 124 });
  });
});
