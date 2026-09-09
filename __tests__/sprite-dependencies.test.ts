import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dependencyFingerprint, type SpriteDependencyManifest } from "../lib/runner/sprites-baseline";
import { prepareSpriteDependencies } from "../lib/worker-runtime/dependencies";

const exec = promisify(execFile);
const oldEnv = { reuse: process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE, fp: process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT, options: process.env.TASK_ORCH_SPRITE_NPM_OPTIONS };
const temporaryDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [key, value] of [["TASK_ORCH_SPRITE_DEPENDENCY_REUSE", oldEnv.reuse], ["TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT", oldEnv.fp], ["TASK_ORCH_SPRITE_NPM_OPTIONS", oldEnv.options]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sprite-deps-"));
  temporaryDirs.push(dir);
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "package-lock.json"), "{\"lockfileVersion\":3}");
  await writeFile(join(dir, "package.json"), "{\"name\":\"fixture\"}");
  await exec("git", ["init", "-q", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Test"]);
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-qm", "fixture"]);
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "HEAD"]);
  const sha = async (name: string) => (await exec("shasum", ["-a", "256", join(dir, name)])).stdout.split(/\s/)[0];
  const manifest: SpriteDependencyManifest = {
    repository: "fixture/project", revision: stdout.trim(),
    lockfile: { path: "package-lock.json", sha256: await sha("package-lock.json") },
    packageManifests: [{ path: "package.json", sha256: await sha("package.json") }],
    packageManager: "npm", packageManagerVersion: (await exec("npm", ["--version"])).stdout.trim(), installOptions: ["--no-audit"],
  };
  return { dir, manifest, fingerprint: dependencyFingerprint(manifest) };
}

function enable(fingerprint: string, options?: string) {
  process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE = "1";
  process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT = fingerprint;
  if (options !== undefined) process.env.TASK_ORCH_SPRITE_NPM_OPTIONS = options;
}

describe("Sprite dependency reuse", () => {
  it("reuses compatible inputs without installing", async () => {
    const f = await fixture(); await writeFile(join(f.dir, ".sprite-dependency-fingerprint"), f.fingerprint); enable(f.fingerprint);
    let calls = 0; expect(await prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async () => { calls++; } })).toBe("reused"); expect(calls).toBe(0);
  });
  it("installs when the lockfile changes", async () => {
    vi.stubEnv("TASK_ORCH_LOG_FORMAT", "json"); vi.stubEnv("RUN_ID", "208");
    vi.stubEnv("TASK_ORCH_WORKER_GENERATION", "3");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = await fixture(); await writeFile(join(f.dir, ".sprite-dependency-fingerprint"), f.fingerprint); await writeFile(join(f.dir, "package-lock.json"), "changed"); enable(f.fingerprint);
    let calls = 0; expect(await prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async () => { calls++; } })).toBe("installed"); expect(calls).toBe(1);
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: "sprites_dependency_decision", runId: 208, workerGeneration: 3, reason: "lockfile_changed", reused: false }));
  });
  it("installs when the pinned Git revision changes", async () => {
    const f = await fixture(); await writeFile(join(f.dir, ".sprite-dependency-fingerprint"), f.fingerprint); await writeFile(join(f.dir, "package.json"), "changed"); await exec("git", ["-C", f.dir, "add", "."]); await exec("git", ["-C", f.dir, "commit", "-qm", "change"]); enable(f.fingerprint);
    let calls = 0; expect(await prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async () => { calls++; } })).toBe("installed"); expect(calls).toBe(1);
  });
  it("installs when node_modules is missing", async () => {
    const f = await fixture(); await writeFile(join(f.dir, ".sprite-dependency-fingerprint"), f.fingerprint); await exec("rm", ["-rf", join(f.dir, "node_modules")]); enable(f.fingerprint);
    let calls = 0; expect(await prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async () => { calls++; } })).toBe("installed"); expect(calls).toBe(1);
  });
  it("does not leave a readiness marker after install failure", async () => {
    const f = await fixture(); await writeFile(join(f.dir, ".sprite-dependency-fingerprint"), "stale"); enable(f.fingerprint);
    await expect(prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async () => { throw new Error("failed"); } })).rejects.toThrow();
    await expect((await import("node:fs/promises")).readFile(join(f.dir, ".sprite-dependency-fingerprint"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("passes custom npm options to the installer", async () => {
    const f = await fixture(); f.manifest.installOptions = ["--ignore-scripts", "--no-fund"]; enable(dependencyFingerprint(f.manifest)); const args: string[][] = [];
    expect(await prepareSpriteDependencies(f.dir, { manifest: f.manifest, install: async (_dir, values) => { args.push(values); } })).toBe("installed"); expect(args).toEqual([["--ignore-scripts", "--no-fund"]]);
  });
});
