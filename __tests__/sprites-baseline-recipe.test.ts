import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateSpriteBaseline } from "../lib/runner/sprites-baseline-recipe";
import { getConfiguredSpriteBaselines } from "../lib/runner/sprites-pool-config";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const recipe = () => ({
  repositoryId: "R-project", repository: "https://github.com/acme/project.git", allowedUserIds: [7],
  packageManagerVersion: "10.9.8", reusePolicy: "inputs", installScriptInputs: ["scripts/install.js"],
  buildCommands: ["npm run build"], readinessCommands: ["npm run check:ready"],
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sprite-recipe-")); roots.push(root);
  await mkdir(join(root, "packages/core"), { recursive: true });
  await mkdir(join(root, "scripts"));
  const pkg = JSON.stringify({ name: "fixture", workspaces: ["packages/*"] });
  await writeFile(join(root, "package.json"), pkg);
  await writeFile(join(root, "packages/core/package.json"), '{"name":"core"}');
  await writeFile(join(root, "scripts/install.js"), "// audited install input\n");
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "": { name: "fixture", workspaces: ["packages/*"] }, "packages/core": { name: "core" },
    "node_modules/core": { resolved: "packages/core", link: true },
    "packages/core/node_modules/dependency": { version: "1.0.0" },
  } }));
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.com");
  await git("add", "."); await git("commit", "-m", "fixture");
  return { root, git, revision: await git("rev-parse", "HEAD"), pkg };
}

describe("Sprite baseline recipe", () => {
  it("hashes pinned git blobs and all locked workspace manifests, not dirty checkout files", async () => {
    const { root, revision, pkg } = await fixture();
    await writeFile(join(root, "package.json"), "uncommitted change");
    const spec = await generateSpriteBaseline(root, revision, recipe());
    const deps = spec.manifest.dependency;
    expect(deps.revision).toBe(revision);
    expect(deps.packageManifests).toEqual([
      { path: "package.json", sha256: createHash("sha256").update(pkg).digest("hex") },
      { path: "packages/core/package.json", sha256: createHash("sha256").update('{"name":"core"}').digest("hex") },
    ]);
    expect(deps.installScriptInputs?.map((file) => file.path)).toEqual(["scripts/install.js"]);
    expect(deps.npmConfig).toBeNull();
    expect(spec.manifest).toMatchObject({ platform: "linux", architecture: "x64", nodeVersion: "v22.22.3" });
    expect(getConfiguredSpriteBaselines("a".repeat(40), JSON.stringify([spec]))).toHaveLength(1);
  });

  it("keeps conservative reuse by default and requires an explicit audit list for input reuse", async () => {
    const { root } = await fixture();
    const { installScriptInputs: _inputs, reusePolicy: _policy, ...base } = recipe();
    expect((await generateSpriteBaseline(root, "HEAD", base)).manifest.dependency.reusePolicy).toBe("revision");
    await expect(generateSpriteBaseline(root, "HEAD", { ...base, reusePolicy: "inputs" })).rejects.toThrow("explicit installScriptInputs");
  });

  it("does not execute setup or build commands while generating a profile", async () => {
    const { root } = await fixture();
    await generateSpriteBaseline(root, "HEAD", { ...recipe(), setupCommands: ["touch executed"], buildCommands: ["touch executed"] });
    await expect(access(join(root, "executed"))).rejects.toThrow();
  });

  it("pins repository npm configuration when present", async () => {
    const { root, git } = await fixture();
    const config = "legacy-peer-deps=true\n";
    await writeFile(join(root, ".npmrc"), config);
    await git("add", ".npmrc"); await git("commit", "-m", "npm config");
    const spec = await generateSpriteBaseline(root, "HEAD", recipe());
    expect(spec.manifest.dependency.npmConfig).toEqual({ path: ".npmrc", sha256: createHash("sha256").update(config).digest("hex") });
  });

  it("rejects unsupported lockfile formats instead of guessing workspace inputs", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 4, packages: { "": {} } }));
    await git("add", "package-lock.json"); await git("commit", "-m", "unsupported lockfile");
    await expect(generateSpriteBaseline(root, "HEAD", recipe())).rejects.toThrow("version 2 or 3");
  });

  it("rejects an untracked or symlinked input instead of hashing mutable external content", async () => {
    const { root, git } = await fixture();
    await writeFile(join(root, "untracked.js"), "untracked");
    await expect(generateSpriteBaseline(root, "HEAD", { ...recipe(), installScriptInputs: ["untracked.js"] })).rejects.toThrow("tracked regular file");
    await symlink("scripts/install.js", join(root, "linked.js"));
    await git("add", "linked.js"); await git("commit", "-m", "symlink");
    await expect(generateSpriteBaseline(root, "HEAD", { ...recipe(), installScriptInputs: ["linked.js"] })).rejects.toThrow("tracked regular file");
    await expect(generateSpriteBaseline(root, "HEAD", { ...recipe(), installScriptInputs: ["../outside.js"] })).rejects.toThrow("relative repository files");
  });

  it("rejects credential-bearing remotes and unsupported install flags", async () => {
    const { root } = await fixture();
    await expect(generateSpriteBaseline(root, "HEAD", { ...recipe(), repository: "https://token@github.com/acme/project.git" })).rejects.toThrow("credential-free HTTPS");
    await expect(generateSpriteBaseline(root, "HEAD", { ...recipe(), installOptions: ["--force"] })).rejects.toThrow();
  });
});
