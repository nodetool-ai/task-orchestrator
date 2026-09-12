import { getOctokit } from "../github-client";
import {
  generateSpriteBaselineFromReader,
  type GeneratedSpriteBaseline,
  type ImmutableSpriteBaselineReader,
} from "./sprites-baseline-recipe";

const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const REGULAR_FILE_MODE = /^100(644|755)$/;

export const GITHUB_BASELINE_BLOB_CONCURRENCY = 6;
export const GITHUB_BASELINE_MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const GITHUB_BASELINE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

interface GithubTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
  size?: number;
}

export interface GithubBaselineClient {
  repos: {
    getCommit(input: { owner: string; repo: string; ref: string }): Promise<{
      data: { sha: string; commit: { tree: { sha: string } } };
    }>;
  };
  git: {
    getTree(input: { owner: string; repo: string; tree_sha: string; recursive: "true" }): Promise<{
      data: { truncated?: boolean; tree: GithubTreeEntry[] };
    }>;
    getBlob(input: { owner: string; repo: string; file_sha: string }): Promise<{
      data: { content?: string; encoding?: string; size?: number };
    }>;
  };
}

interface GithubRepository {
  owner: string;
  repo: string;
}

function parseSafeGithubRemote(remote: string): GithubRepository {
  const match = GITHUB_REMOTE.exec(remote);
  if (!match) {
    throw new Error("GitHub baseline remote must be a credential-free HTTPS github.com repository URL");
  }
  return { owner: match[1], repo: match[2] };
}

function recipeForRemote(recipe: unknown, remote: string, repository: GithubRepository): unknown {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) return recipe;
  const record = recipe as Record<string, unknown>;
  if (record.repository !== undefined) {
    if (typeof record.repository !== "string") return recipe;
    const declared = parseSafeGithubRemote(record.repository);
    if (declared.owner.toLowerCase() !== repository.owner.toLowerCase()
      || declared.repo.toLowerCase() !== repository.repo.toLowerCase()) {
      throw new Error("Sprite baseline recipe repository differs from the registered GitHub remote");
    }
  }
  return { ...record, repository: remote };
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function decodeBlob(
  data: { content?: string; encoding?: string; size?: number },
  expectedSize: number,
  path: string,
): Buffer {
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(`GitHub returned an unsupported blob representation for ${path}`);
  }
  const encoded = data.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`GitHub returned invalid base64 blob content for ${path}`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== expectedSize || (data.size !== undefined && data.size !== expectedSize)) {
    throw new Error(`GitHub blob size differs from the immutable tree for ${path}`);
  }
  return bytes;
}

async function githubReader(
  repository: GithubRepository,
  ref: string,
  github: GithubBaselineClient,
): Promise<ImmutableSpriteBaselineReader> {
  const requestedRef = ref.trim();
  if (!requestedRef) throw new Error("GitHub baseline ref must not be empty");

  // Resolve the caller's mutable branch/tag exactly once. Every later request
  // is addressed by immutable object SHA returned from this commit response.
  const resolved = await github.repos.getCommit({ ...repository, ref: requestedRef });
  const revision = resolved.data.sha;
  const treeSha = resolved.data.commit?.tree?.sha;
  if (!GIT_SHA.test(revision) || !GIT_SHA.test(treeSha ?? "")) {
    throw new Error("GitHub baseline requires a SHA-1 commit and tree");
  }
  const tree = await github.git.getTree({ ...repository, tree_sha: treeSha, recursive: "true" });
  if (tree.data.truncated) {
    throw new Error(`GitHub returned a truncated recursive tree for baseline commit ${revision}`);
  }

  const files = new Map<string, { sha: string; size: number }>();
  for (const entry of tree.data.tree) {
    if (entry.type !== "blob" || !REGULAR_FILE_MODE.test(entry.mode ?? "")) continue;
    if (typeof entry.path !== "string" || !GIT_SHA.test(entry.sha ?? "")
      || !Number.isSafeInteger(entry.size) || (entry.size ?? -1) < 0) continue;
    if (files.has(entry.path)) throw new Error(`GitHub recursive tree contains duplicate path: ${entry.path}`);
    files.set(entry.path, { sha: entry.sha!, size: entry.size! });
  }

  const gate = new ConcurrencyGate(GITHUB_BASELINE_BLOB_CONCURRENCY);
  const blobs = new Map<string, Promise<Buffer>>();
  let reservedBytes = 0;
  const readRegularFile = (path: string): Promise<Buffer> => {
    const file = files.get(path);
    if (!file) return Promise.reject(new Error(`Baseline input is not a tracked regular GitHub blob: ${path}`));
    const cached = blobs.get(file.sha);
    if (cached) return cached;
    if (file.size > GITHUB_BASELINE_MAX_BLOB_BYTES) {
      return Promise.reject(new Error(`GitHub baseline blob exceeds ${GITHUB_BASELINE_MAX_BLOB_BYTES} bytes: ${path}`));
    }
    if (reservedBytes + file.size > GITHUB_BASELINE_MAX_TOTAL_BYTES) {
      return Promise.reject(new Error(`GitHub baseline inputs exceed ${GITHUB_BASELINE_MAX_TOTAL_BYTES} bytes`));
    }
    reservedBytes += file.size;
    const loading = gate.run(async () => {
      const response = await github.git.getBlob({ ...repository, file_sha: file.sha });
      return decodeBlob(response.data, file.size, path);
    });
    blobs.set(file.sha, loading);
    return loading;
  };

  return {
    revision,
    hasRegularFile: (path) => files.has(path),
    readRegularFile,
  };
}

/** Generate a Sprite baseline without checking out or executing repository code. */
export async function generateGithubSpriteBaseline(
  remote: string,
  ref: string,
  recipe: unknown,
  github: GithubBaselineClient = getOctokit() as unknown as GithubBaselineClient,
): Promise<GeneratedSpriteBaseline> {
  const repository = parseSafeGithubRemote(remote);
  const boundedRecipe = recipeForRemote(recipe, remote, repository);
  const source = await githubReader(repository, ref, github);
  return generateSpriteBaselineFromReader(source, boundedRecipe);
}
