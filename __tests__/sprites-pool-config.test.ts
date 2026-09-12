import { describe, expect, it } from "vitest";
import { getConfiguredSpriteBaselines } from "../lib/runner/sprites-pool-config";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
function generic(extra: Record<string, unknown> = {}) {
  return { manifest: { schemaVersion: 1, nodeVersion: "v22.14.0", codexVersion: "0.153.4", platform: "linux", architecture: "x64", systemToolsVersion: "sprite-base-v1", ...extra }, target: 1 };
}
function repository(extra: Record<string, unknown> = {}) {
  return { ...generic(), manifest: { ...generic().manifest, dependency: { repository: "https://github.com/acme/project.git", revision: sha, lockfile: { path: "package-lock.json", sha256: digest }, packageManifests: [{ path: "package.json", sha256: digest }], packageManager: "npm", packageManagerVersion: "10.9.2", installOptions: ["--no-audit"] } }, repositoryId: "repo-1", allowedUserIds: [7], ...extra };
}
const parse = (value: unknown, worker = sha) => getConfiguredSpriteBaselines(worker, JSON.stringify([value]));

describe("Sprite pool baseline configuration", () => {
  it("hydrates a valid generic baseline with the deployed worker SHA", () => {
    const [result] = parse(generic());
    expect(result.manifest.workerBundleSha).toBe(sha);
    expect(result.target).toBe(1);
  });
  it("changes fingerprint when deployed worker SHA changes", () => {
    expect(parse(generic(), sha)[0].fingerprint).not.toBe(parse(generic(), "c".repeat(40))[0].fingerprint);
  });
  it.each(["nodeVersion", "codexVersion", "architecture", "systemToolsVersion"])("rejects invalid %s", (field) => {
    const value = generic({ [field]: field === "architecture" ? "mips" : field === "systemToolsVersion" ? "old" : "invalid" });
    expect(() => parse(value)).toThrow();
  });
  it("requires explicit repository scope for dependency baselines", () => {
    expect(() => parse({ ...repository(), repositoryId: undefined })).toThrow();
    expect(() => parse({ ...repository(), allowedUserIds: undefined })).toThrow();
  });
  it("hydrates conservative policy and install runtime from the baseline", () => {
    const [result] = parse(repository());
    expect(result.manifest.dependency).toMatchObject({
      reusePolicy: "revision",
      installRuntime: { nodeVersion: "v22.14.0", platform: "linux", architecture: "x64" },
    });
  });
  it("requires explicit lifecycle and npm config declarations for input-scoped reuse", () => {
    const dep = repository().manifest.dependency;
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: { ...dep, reusePolicy: "inputs" } } })).toThrow(/installScriptInputs/);
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: { ...dep, reusePolicy: "inputs", installScriptInputs: [] } } })).toThrow(/npmConfig/);
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: { ...dep, reusePolicy: "inputs", installScriptInputs: [], npmConfig: null } } })).not.toThrow();
  });
  it("rejects a dependency runtime that differs from its baseline", () => {
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: {
      ...repository().manifest.dependency,
      installRuntime: { nodeVersion: "v20.0.0", platform: "linux", architecture: "x64" },
    } } })).toThrow(/install runtime differs/);
  });
  it.each(["https://user:pass@github.com/acme/project.git", "https://github.com/acme/project.git?token=x", "../project"])("rejects unsafe remote %s", (remote) => {
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: { ...repository().manifest.dependency, repository: remote } } })).toThrow();
  });
  it("rejects path traversal, pinned mismatch, and duplicate fingerprints", () => {
    expect(() => parse({ ...repository(), manifest: { ...repository().manifest, dependency: { ...repository().manifest.dependency, lockfile: { path: "../package-lock.json", sha256: digest } } } })).toThrow();
    expect(() => parse({ ...repository(), revision: "c".repeat(40) })).toThrow();
    expect(() => getConfiguredSpriteBaselines(sha, JSON.stringify([generic(), generic()]))).toThrow();
  });
  it("accepts only unique package manifest paths as workspace output exclusions", () => {
    const dependency = {
      ...repository().manifest.dependency,
      packageManifests: [
        { path: "package.json", sha256: digest },
        { path: "packages/private/package.json", sha256: digest },
      ],
    };
    const withExclusions = (workspaceOutputExclusions: string[]) => parse({
      ...repository(), manifest: { ...repository().manifest, dependency: { ...dependency, workspaceOutputExclusions } },
    });
    expect(() => withExclusions(["packages/private/package.json"])).not.toThrow();
    expect(() => withExclusions(["scripts/setup.js"])).toThrow(/workspace package manifest/);
    expect(() => withExclusions(["../package.json"])).toThrow(/relative repository files/);
    expect(() => withExclusions(["packages/private/package.json", "packages/private/package.json"])).toThrow(/unique/);
  });
});
