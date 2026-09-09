import { describe, expect, it } from "vitest";

import {
  SPRITE_CHECKOUT_PATH,
  baselineFingerprint,
  canonicalBaselineManifest,
  dependencyPreparationCommand,
  type SpriteBaselineManifest,
  verifyBaseline,
  writeBaselineManifest,
} from "../lib/runner/sprites-baseline";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);

const manifest = (): SpriteBaselineManifest => ({
  schemaVersion: 1,
  workerBundleSha: "a".repeat(40),
  nodeVersion: "v22.14.0",
  codexVersion: "0.153.4",
  platform: "linux",
  architecture: "x64",
  systemToolsVersion: "fly-2026-09",
  dependency: {
    repository: "acme/project",
    lockfile: { path: "package-lock.json", sha256: "1".repeat(64) },
    packageManifests: [],
    packageManager: "npm",
    packageManagerVersion: "10.9.2",
    installOptions: ["--ignore-scripts"],
  },
});

describe("Sprite baseline identity", () => {
  it("canonicalizes object key order and fingerprints changes", () => {
    const a = manifest();
    const b = { ...a, dependency: { ...a.dependency!, packageManifests: [] } };
    expect(canonicalBaselineManifest(a)).toBe(canonicalBaselineManifest(b));
    expect(baselineFingerprint(a)).toHaveLength(64);
    expect(baselineFingerprint({ ...a, nodeVersion: "v22.15.0" })).not.toBe(baselineFingerprint(a));
  });

  it("prepares the worker's stable checkout and cache", () => {
    const command = dependencyPreparationCommand({ remote: "https://github.com/acme/project.git", branch: "main" });
    expect(command).toContain(SPRITE_CHECKOUT_PATH);
    expect(command).toContain("npm ci --cache '/home/user/session/.npm-cache'");
    expect(command).not.toContain("|| true");
  });
});

describe("Sprite baseline verification", () => {
  it("executes real checks for worker, tools, and sealed manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "sprite-baseline-"));
    await mkdir(join(root, "worker/dist"), { recursive: true });
    await mkdir(join(root, "session"), { recursive: true });
    const worker = join(root, "worker/dist/run-worker.js");
    await writeFile(worker, "worker fixture\n");
    const workerSha = createHash("sha1").update(await readFile(worker)).digest("hex");
    const codex = join(root, "worker/codex");
    await writeFile(codex, "#!/bin/sh\nprintf '0.153.4\\n'\n"); await chmod(codex, 0o755);
    const manifest: SpriteBaselineManifest = { schemaVersion: 1, workerBundleSha: workerSha, nodeVersion: process.version, codexVersion: "0.153.4", platform: process.platform, architecture: process.arch, systemToolsVersion: "sprite-base-v1" };
    const client = { exec: async (_sprite: string, input: { cmd: string }) => {
      const cmd = input.cmd.replaceAll("/home/user", root);
      try { const result = await exec("/bin/sh", ["-c", cmd]); return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; }
      catch (error) { const e = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: Number(e.code ?? 1), stdout: e.stdout ?? "", stderr: e.stderr ?? "" }; }
    } } as never;
    await writeBaselineManifest(client, "fixture", manifest);
    await expect(verifyBaseline(client, "fixture", manifest, "/home/user/worker/codex")).resolves.toBeUndefined();
    await writeFile(worker, "corrupt\n");
    await expect(verifyBaseline(client, "fixture", manifest, "/home/user/worker/codex")).rejects.toThrow();
    await writeFile(worker, "worker fixture\n");
    await expect(verifyBaseline(client, "fixture", { ...manifest, nodeVersion: "v0.0.0" }, "/home/user/worker/codex")).rejects.toThrow();
    const sealed = join(root, "session/.sprite-baseline/manifest.json");
    await chmod(sealed, 0o644);
    const tampered = JSON.parse(await readFile(sealed, "utf8")); tampered.workerBundleSha = "f".repeat(40); await writeFile(sealed, JSON.stringify(tampered));
    await expect(verifyBaseline(client, "fixture", manifest, "/home/user/worker/codex")).rejects.toThrow();
  });
});
