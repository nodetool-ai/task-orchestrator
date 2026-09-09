import { z } from "zod";
import { baselineFingerprint, SPRITE_BASELINE_SCHEMA_VERSION, type SpriteBaselineManifest } from "./sprites-baseline";

export interface ConfiguredSpriteBaseline {
  manifest: SpriteBaselineManifest;
  fingerprint: string;
  target: number;
  repositoryId?: string;
  remote?: string;
  revision?: string;
  allowedUserIds?: number[];
}

const relativePath = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.includes("\\"), "dependency input must be a relative repository path");
const digest = z.object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const remoteUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "baseline remote must be credential-free HTTPS");
const dependency = z.object({
  repository: remoteUrl,
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  lockfile: digest.extend({ path: z.literal("package-lock.json") }),
  packageManifests: z.array(digest).min(1).refine((files) => files.some((file) => file.path === "package.json"), "package.json is required"),
  packageManager: z.literal("npm"),
  packageManagerVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  installOptions: z.array(z.enum(["--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--include=dev", "--include=optional", "--omit=dev"])),
  installScriptInputs: z.array(digest).optional(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(SPRITE_BASELINE_SCHEMA_VERSION),
  workerBundleSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
  codexVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  platform: z.literal("linux"),
  architecture: z.enum(["x64", "arm64"]),
  systemToolsVersion: z.literal("sprite-base-v1"),
  dependency: dependency.optional(),
}).strict();
const specSchema = z.object({
  manifest: manifestSchema, target: z.number().int().nonnegative().default(1),
  repositoryId: z.string().min(1).optional(), remote: remoteUrl.optional(),
  revision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  allowedUserIds: z.array(z.number().int().positive()).min(1).optional(),
}).strict();

/** Worker SHA is hydrated from the shipped bundle unless explicitly pinned. */
export function getConfiguredSpriteBaselines(workerSha: string, raw = process.env.TASK_ORCH_SPRITE_POOL_BASELINES): ConfiguredSpriteBaseline[] {
  if (!raw?.trim()) return [];
  const parsed = z.array(specSchema).parse(JSON.parse(raw));
  const seen = new Set<string>();
  return parsed.map((item) => {
    if (item.manifest.workerBundleSha && item.manifest.workerBundleSha !== workerSha) throw new Error("Sprite baseline worker SHA differs from the deployed bundle");
    const manifest = { ...item.manifest, workerBundleSha: workerSha } as SpriteBaselineManifest;
    if (manifest.dependency) {
      if (!item.repositoryId || !item.allowedUserIds?.length) throw new Error("Repository baselines require repositoryId and allowedUserIds");
      if (item.remote && item.remote !== manifest.dependency.repository) throw new Error("Baseline repository remotes differ");
      if (item.revision && item.revision !== manifest.dependency.revision) throw new Error("Baseline repository revisions differ");
    } else if (item.repositoryId || item.remote || item.revision || item.allowedUserIds) {
      throw new Error("Generic baselines cannot carry repository scope");
    }
    const fingerprint = baselineFingerprint(manifest);
    if (seen.has(fingerprint)) throw new Error("Duplicate Sprite baseline fingerprint");
    seen.add(fingerprint);
    return { ...item, manifest, fingerprint,
      remote: manifest.dependency?.repository, revision: manifest.dependency?.revision };
  });
}
