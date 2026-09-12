import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dependencyFingerprint, type SpriteDependencyManifest } from "../lib/runner/sprites-baseline";
import { prepareSpriteDependencies } from "../lib/worker-runtime/dependencies";

const exec = promisify(execFile);
const oldEnv = { reuse: process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE, fp: process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT };
const temporaryDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const [key, value] of [["TASK_ORCH_SPRITE_DEPENDENCY_REUSE", oldEnv.reuse], ["TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT", oldEnv.fp]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function fixture(policy: "revision" | "inputs" = "inputs", buildCommands?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "sprite-deps-"));
  temporaryDirs.push(dir);
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, ".gitignore"), "node_modules/\nbuild.log\n");
  await writeFile(join(dir, "package-lock.json"), "{\"lockfileVersion\":3}");
  await writeFile(join(dir, "package.json"), "{\"name\":\"fixture\"}");
  await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
  await writeFile(join(dir, "install-input.txt"), "stable\n");
  await exec("git", ["init", "-q", dir]);
  await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Test"]);
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-qm", "fixture"]);
  const revision = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  const digest = async (name: string) => createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
  const manifest: SpriteDependencyManifest = {
    repository: "fixture/project", revision,
    lockfile: { path: "package-lock.json", sha256: await digest("package-lock.json") },
    packageManifests: [{ path: "package.json", sha256: await digest("package.json") }],
    packageManager: "npm", packageManagerVersion: (await exec("npm", ["--version"])).stdout.trim(),
    installOptions: ["--no-audit"], reusePolicy: policy,
    ...(policy === "inputs" ? { npmConfig: null, installScriptInputs: [{ path: "install-input.txt", sha256: await digest("install-input.txt") }] } : {}),
    ...(buildCommands ? { buildCommands } : {}),
  };
  return { dir, manifest, fingerprint: dependencyFingerprint(manifest) };
}

function enable(fingerprint: string) {
  process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE = "1";
  process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT = fingerprint;
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>, install: (dir: string, args: string[]) => Promise<void> = async () => {}) {
  enable(f.fingerprint);
  return prepareSpriteDependencies(f.dir, { manifest: f.manifest, install });
}

describe("Sprite dependency reuse", () => {
  it("reuses an input-scoped tree across an ordinary source commit and rebuilds outputs", async () => {
    const command = "node -e \"require('fs').appendFileSync('build.log','built\\n')\"";
    const f = await fixture("inputs", [command]);
    let installs = 0;
    expect(await prepare(f, async () => { installs++; })).toBe("installed");
    await writeFile(join(f.dir, "source.ts"), "export const value = 2;\n");
    await exec("git", ["-C", f.dir, "add", "source.ts"]);
    await exec("git", ["-C", f.dir, "commit", "-qm", "source change"]);
    expect(await prepare(f, async () => { installs++; })).toBe("reused");
    expect(installs).toBe(1);
    expect((await readFile(join(f.dir, "build.log"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("rebuilds for a nonignored untracked source file without reinstalling", async () => {
    const command = "node -e \"require('fs').appendFileSync('build.log','built\\n')\"";
    const f = await fixture("inputs", [command]);
    let installs = 0; await prepare(f, async () => { installs++; });
    await writeFile(join(f.dir, "new-source.ts"), "export {};\n");
    expect(await prepare(f, async () => { installs++; })).toBe("reused");
    expect(installs).toBe(1);
    expect((await readFile(join(f.dir, "build.log"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("keeps conservative revision invalidation for legacy profiles", async () => {
    const f = await fixture("revision"); let installs = 0; await prepare(f, async () => { installs++; });
    await writeFile(join(f.dir, "source.ts"), "export const value = 2;\n");
    await exec("git", ["-C", f.dir, "add", "source.ts"]); await exec("git", ["-C", f.dir, "commit", "-qm", "change"]);
    expect(await prepare(f, async () => { installs++; })).toBe("installed");
    expect(installs).toBe(2);
  });

  it("reinstalls when the lockfile changes and records the reason", async () => {
    vi.stubEnv("TASK_ORCH_LOG_FORMAT", "json"); vi.stubEnv("RUN_ID", "208"); vi.stubEnv("TASK_ORCH_WORKER_GENERATION", "3");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const f = await fixture(); let installs = 0; await prepare(f, async () => { installs++; });
    await writeFile(join(f.dir, "package-lock.json"), "changed");
    expect(await prepare(f, async () => { installs++; })).toBe("installed");
    expect(installs).toBe(2);
    expect(logs.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(expect.objectContaining({ event: "sprites_dependency_decision", runId: 208, workerGeneration: 3, reason: "lockfile_changed", reused: false }));
  });

  it("reinstalls when a declared install-script input changes", async () => {
    const f = await fixture(); let installs = 0; await prepare(f, async () => { installs++; });
    await writeFile(join(f.dir, "install-input.txt"), "changed\n");
    expect(await prepare(f, async () => { installs++; })).toBe("installed");
    expect(installs).toBe(2);
  });

  it("reinstalls when a root npm config is introduced", async () => {
    const f = await fixture(); let installs = 0; await prepare(f, async () => { installs++; });
    await writeFile(join(f.dir, ".npmrc"), "legacy-peer-deps=true\n");
    expect(await prepare(f, async () => { installs++; })).toBe("installed");
    expect(installs).toBe(2);
  });

  it("installs when node_modules is missing", async () => {
    const f = await fixture(); let installs = 0; await prepare(f, async () => { installs++; });
    await rm(join(f.dir, "node_modules"), { recursive: true, force: true });
    await expect(prepare(f, async () => { installs++; })).rejects.toThrow(/dependencies missing/);
    expect(installs).toBe(2);
  });

  it("invalidates dependency receipts before a failed install", async () => {
    const f = await fixture(); await prepare(f);
    await writeFile(join(f.dir, "package-lock.json"), "changed");
    await expect(prepare(f, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(readFile(join(f.dir, ".sprite-dependency-fingerprint"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.dir, ".sprite-dependency-manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates only the build receipt when a rebuild fails", async () => {
    const f = await fixture("inputs", ["node -e \"process.exit(0)\""]); await prepare(f);
    await writeFile(join(f.dir, "source.ts"), "changed\n");
    f.manifest.buildCommands = ["node -e \"process.exit(7)\""];
    await expect(prepare(f)).rejects.toThrow();
    await expect(readFile(join(f.dir, ".sprite-build-fingerprint"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(f.dir, ".sprite-dependency-fingerprint"), "utf8")).resolves.toBeTruthy();
  });

  it("passes custom npm options to the installer", async () => {
    const f = await fixture(); f.manifest.installOptions = ["--ignore-scripts", "--no-fund"]; f.fingerprint = dependencyFingerprint(f.manifest);
    const args: string[][] = [];
    expect(await prepare(f, async (_dir, values) => { args.push(values); })).toBe("installed");
    expect(args).toEqual([["--ignore-scripts", "--no-fund"]]);
  });
});
