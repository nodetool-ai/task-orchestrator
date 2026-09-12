import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_BASELINE_MAX_BLOB_BYTES,
  generateGithubSpriteBaseline,
  type GithubBaselineClient,
} from "../lib/runner/sprites-baseline-github";
import { generateSpriteBaseline } from "../lib/runner/sprites-baseline-recipe";

const exec = promisify(execFile);
const roots: string[] = [];
const remote = "https://github.com/acme/project.git";
const treeSha = "b".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const recipe = () => ({
  repositoryId: "R-project",
  repository: remote,
  allowedUserIds: [7],
  packageManagerVersion: "10.9.8",
  reusePolicy: "inputs",
  installScriptInputs: ["scripts/install.js"],
  buildCommands: ["npm run build"],
  readinessCommands: ["npm run check:ready"],
});

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

class FakeGithub implements GithubBaselineClient {
  readonly commitRefs: string[] = [];
  readonly treeRefs: string[] = [];
  readonly blobRefs: string[] = [];
  activeBlobs = 0;
  maxActiveBlobs = 0;

  private readonly entries: Array<{ path: string; mode: string; type: string; sha: string; size: number }>;
  private readonly blobs = new Map<string, Buffer>();

  constructor(readonly revision: string, files: Record<string, Buffer>, private readonly delayMs = 0) {
    this.entries = Object.entries(files).map(([path, bytes]) => {
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      return { path, mode: "100644", type: "blob", sha, size: bytes.length };
    });
  }

  repos!: GithubBaselineClient["repos"];
  git!: GithubBaselineClient["git"];

  initialize(): this {
    this.repos = {
      getCommit: async ({ owner, repo, ref }) => {
        expect({ owner, repo }).toEqual({ owner: "acme", repo: "project" });
        this.commitRefs.push(ref);
        return { data: { sha: this.revision, commit: { tree: { sha: treeSha } } } };
      },
    };
    this.git = {
      getTree: async ({ owner, repo, tree_sha, recursive }) => {
        expect({ owner, repo, recursive }).toEqual({ owner: "acme", repo: "project", recursive: "true" });
        this.treeRefs.push(tree_sha);
        return { data: { truncated: false, tree: this.entries } };
      },
      getBlob: async ({ owner, repo, file_sha }) => {
        expect({ owner, repo }).toEqual({ owner: "acme", repo: "project" });
        this.blobRefs.push(file_sha);
        this.activeBlobs += 1;
        this.maxActiveBlobs = Math.max(this.maxActiveBlobs, this.activeBlobs);
        try {
          if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          const bytes = this.blobs.get(file_sha);
          if (!bytes) throw new Error("missing blob");
          return { data: { encoding: "base64", content: bytes.toString("base64"), size: bytes.length } };
        } finally {
          this.activeBlobs -= 1;
        }
      },
    };
    return this;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sprite-github-recipe-"));
  roots.push(root);
  await mkdir(join(root, "packages/core"), { recursive: true });
  await mkdir(join(root, "scripts"));
  const files: Record<string, Buffer> = {
    "package.json": Buffer.from('{"name":"fixture"}'),
    "packages/core/package.json": Buffer.from('{"name":"core"}'),
    "scripts/install.js": Buffer.from("// audited install input\n"),
    ".npmrc": Buffer.from("legacy-peer-deps=true\n"),
    "package-lock.json": Buffer.from(JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "fixture" }, "packages/core": { name: "core" } },
    })),
  };
  await Promise.all(Object.entries(files).map(([path, bytes]) => writeFile(join(root, path), bytes)));
  const git = async (...args: string[]) => (await exec("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.com");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  return { root, files, revision: await git("rev-parse", "HEAD") };
}

describe("GitHub Sprite baseline recipe", () => {
  it("produces the same spec as the local immutable git reader", async () => {
    const { root, files, revision } = await fixture();
    const github = new FakeGithub(revision, files, 2).initialize();

    const local = await generateSpriteBaseline(root, revision, recipe());
    const remoteSpec = await generateGithubSpriteBaseline(remote, "main", recipe(), github);

    expect(remoteSpec).toEqual(local);
    expect(github.maxActiveBlobs).toBeGreaterThan(1);
    expect(github.maxActiveBlobs).toBeLessThanOrEqual(6);
  });

  it("resolves the requested ref once and uses only immutable object SHAs afterwards", async () => {
    const { files, revision } = await fixture();
    const github = new FakeGithub(revision, files).initialize();

    await generateGithubSpriteBaseline(remote, "moving-branch", recipe(), github);

    expect(github.commitRefs).toEqual(["moving-branch"]);
    expect(github.treeRefs).toEqual([treeSha]);
    expect(github.blobRefs.length).toBeGreaterThan(0);
    expect(github.blobRefs.every((sha) => /^[a-f0-9]{40}$/.test(sha))).toBe(true);
  });

  it.each([
    "https://token@github.com/acme/project.git",
    "http://github.com/acme/project.git",
    "git@github.com:acme/project.git",
    "https://github.com/acme/project.git?ref=other",
  ])("rejects unsafe registered remote %s before calling GitHub", async (unsafeRemote) => {
    const github = new FakeGithub("a".repeat(40), {}).initialize();
    await expect(generateGithubSpriteBaseline(unsafeRemote, "main", recipe(), github)).rejects.toThrow("credential-free HTTPS");
    expect(github.commitRefs).toEqual([]);
  });

  it("rejects a required path that is not a tracked regular blob", async () => {
    const { files, revision } = await fixture();
    delete files["package-lock.json"];
    const github = new FakeGithub(revision, files).initialize();

    await expect(generateGithubSpriteBaseline(remote, "main", recipe(), github)).rejects.toThrow(
      `tracked regular file at ${revision}: package-lock.json`,
    );
    expect(github.blobRefs).toEqual([]);
  });

  it("rejects a truncated recursive tree before reading blobs", async () => {
    const { files, revision } = await fixture();
    const github = new FakeGithub(revision, files).initialize();
    const getTree = github.git.getTree;
    github.git.getTree = async (input) => {
      const response = await getTree(input);
      return { data: { ...response.data, truncated: true } };
    };

    await expect(generateGithubSpriteBaseline(remote, "main", recipe(), github)).rejects.toThrow("truncated recursive tree");
    expect(github.blobRefs).toEqual([]);
  });

  it("rejects an oversized blob from tree metadata before downloading it", async () => {
    const github = new FakeGithub("a".repeat(40), {
      "package-lock.json": Buffer.from("{}"),
      "package.json": Buffer.from("{}"),
    }).initialize();
    const tree = github.git.getTree;
    github.git.getTree = async (input) => {
      const response = await tree(input);
      response.data.tree[0].size = GITHUB_BASELINE_MAX_BLOB_BYTES + 1;
      return response;
    };

    await expect(generateGithubSpriteBaseline(remote, "main", recipe(), github)).rejects.toThrow("blob exceeds");
    expect(github.blobRefs).toEqual([]);
  });
});
