import { describe, expect, it } from "vitest";

import {
  SPRITE_CHECKOUT_PATH,
  baselineFingerprint,
  canonicalBaselineManifest,
  controlledNpmCiCommand,
  dependencyPreparationCommand,
  dependencyVerificationProgram,
  type SpriteBaselineManifest,
  verifyBaseline,
  writeBaselineManifest,
  writeDependencyManifest,
} from "../lib/runner/sprites-baseline";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(command).toContain("args=[");
    expect(command).toContain("child_process");
    expect(command).toContain(" -- '--cache' '/home/user/session/.npm-cache'");
    expect(command).not.toContain("|| true");
  });

  it("writes ignored dependency and build receipts from a non-checkout exec cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "sprite-receipt-"));
    try {
      const checkout = join(root, "session/repo");
      await mkdir(checkout, { recursive: true });
      await exec("git", ["init", "-q", checkout]);
      const client = { exec: async (_sprite: string, input: { cmd: string }) => {
        try {
          const result = await exec("/bin/sh", ["-c", input.cmd.replaceAll("/home/user", root)], { cwd: root });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          const e = error as { code?: number; stdout?: string; stderr?: string };
          return { exitCode: Number(e.code ?? 1), stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      } } as never;
      await writeDependencyManifest(client, "fixture", manifest().dependency!);
      const excludes = await readFile(join(checkout, ".git/info/exclude"), "utf8");
      expect(excludes).toContain(".sprite-dependency-*");
      expect(excludes).toContain(".sprite-build-fingerprint*");
      await expect(readFile(join(checkout, ".sprite-dependency-fingerprint"), "utf8")).resolves.toHaveLength(64);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("executes npm ci with isolated user/global config and inherited overrides removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "sprite-npm-command-"));
    try {
      const postinstall = "node -e \"require('fs').writeFileSync('installed',process.env.NODE_ENV||'unset')\"";
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { postinstall } }));
      await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", hasInstallScript: true } } }));
      await expect(exec("/bin/sh", ["-c", controlledNpmCiCommand(join(root, ".cache"), ["--no-audit", "--no-fund"])], {
        cwd: root, env: { ...process.env, NODE_ENV: "production", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_PACKAGE_LOCK: "false" },
      })).resolves.toBeDefined();
      expect(await readFile(join(root, "installed"), "utf8")).toBe("unset");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("executes declared-tool, history, workspace-output, and custom readiness checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sprite-ready-"));
    try {
      await mkdir(join(root, "node_modules"), { recursive: true });
      await mkdir(join(root, "packages/core/dist"), { recursive: true });
      await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { typescript: "1.0.0" } }));
      await writeFile(join(root, "package-lock.json"), "lock");
      await writeFile(join(root, "packages/core/package.json"), JSON.stringify({ main: "dist/index.js" }));
      await writeFile(join(root, "packages/core/dist/index.js"), "export {};\n");
      await exec("git", ["init", "-b", "main"], { cwd: root });
      await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
      await exec("git", ["config", "user.name", "Test"], { cwd: root });
      await exec("git", ["add", "."], { cwd: root });
      await exec("git", ["commit", "-m", "fixture"], { cwd: root });
      const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
      const digest = async (path: string) => createHash("sha256").update(await readFile(join(root, path))).digest("hex");
      const dependency = {
        ...manifest().dependency!, revision: sha, minimumGitHistoryDepth: 1,
        lockfile: { path: "package-lock.json", sha256: await digest("package-lock.json") },
        packageManifests: [
          { path: "package.json", sha256: await digest("package.json") },
          { path: "packages/core/package.json", sha256: await digest("packages/core/package.json") },
        ],
        readinessCommands: ["node -e \"process.exit(0)\""],
        packageManagerVersion: (await exec("npm", ["--version"])).stdout.trim(),
      };

      await expect(exec("node", ["-e", dependencyVerificationProgram(dependency, root)], { cwd: root }))
        .rejects.toThrow(/declared tool unavailable: typescript/);

      await mkdir(join(root, "node_modules/typescript"), { recursive: true });
      await writeFile(join(root, "node_modules/typescript/package.json"), JSON.stringify({ name: "typescript", version: "1.0.0" }));
      await expect(exec("node", ["-e", dependencyVerificationProgram(dependency, root)], { cwd: root }))
        .resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Sprite baseline verification", () => {
  it("executes real checks for worker, tools, and sealed manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "sprite-baseline-"));
    await mkdir(join(root, "worker/dist"), { recursive: true });
    await mkdir(join(root, "session"), { recursive: true });
    const worker = join(root, "worker/dist/run-worker.js");
    await writeFile(worker, "worker fixture\n");
    await mkdir(join(root, "worker/codeact"), { recursive: true });
    const wasm = join(root, "worker/codeact/emscripten-module.wasm");
    const wasmSha = `${wasm}.sha256`;
    const threadWorker = join(root, "worker/codeact/thread-worker.js");
    await writeFile(wasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await writeFile(wasmSha, "fixture  emscripten-module.wasm\n");
    await writeFile(threadWorker, "// thread worker fixture\n");
    const bundleHash = createHash("sha1");
    for (const [name, file] of [["dist/run-worker.js", worker], ["codeact/emscripten-module.wasm", wasm], ["codeact/emscripten-module.wasm.sha256", wasmSha], ["codeact/thread-worker.js", threadWorker]]) {
      bundleHash.update(name).update("\0").update(await readFile(file));
    }
    const workerSha = bundleHash.digest("hex");
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
