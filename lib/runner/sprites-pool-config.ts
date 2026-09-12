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
const workspaceManifestPath = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  !value.split("/").some((part) => part === ".." || part === "." || part === ""),
"workspace output exclusions must be relative repository files");
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
  npmConfig: digest.extend({ path: z.literal(".npmrc") }).nullable().optional(),
  installRuntime: z.object({
    nodeVersion: z.string().regex(/^v\d+\.\d+\.\d+$/),
    platform: z.literal("linux"),
    architecture: z.enum(["x64", "arm64"]),
  }).strict().optional(),
  reusePolicy: z.enum(["revision", "inputs"]).optional(),
  installScriptInputs: z.array(digest).optional(),
  setupCommands: z.array(z.string().trim().min(1)).optional(),
  buildCommands: z.array(z.string().trim().min(1)).optional(),
  readinessCommands: z.array(z.string().trim().min(1)).optional(),
  workspaceOutputExclusions: z.array(workspaceManifestPath).optional(),
  minimumGitHistoryDepth: z.number().int().positive().optional(),
  baseRef: z.string().trim().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.reusePolicy === "inputs" && value.installScriptInputs === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["installScriptInputs"],
      message: "input-scoped reuse requires installScriptInputs (use [] to assert none)" });
  }
  if (value.reusePolicy === "inputs" && value.npmConfig === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["npmConfig"],
      message: "input-scoped reuse requires npmConfig (use null to assert .npmrc is absent)" });
  }
  const exclusions = value.workspaceOutputExclusions ?? [];
  const packageManifests = new Set(value.packageManifests.map((file) => file.path));
  const seen = new Set<string>();
  for (const [index, path] of exclusions.entries()) {
    if (seen.has(path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceOutputExclusions", index],
        message: "workspace output exclusions must be unique" });
    }
    seen.add(path);
    if (path === "package.json" || !packageManifests.has(path)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceOutputExclusions", index],
        message: "workspace output exclusion must reference a workspace package manifest" });
    }
  }
});
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
    const declaredDependency = item.manifest.dependency;
    const installRuntime = {
      nodeVersion: item.manifest.nodeVersion,
      platform: item.manifest.platform,
      architecture: item.manifest.architecture,
    };
    if (declaredDependency?.installRuntime
      && JSON.stringify(declaredDependency.installRuntime) !== JSON.stringify(installRuntime)) {
      throw new Error("Dependency install runtime differs from the baseline runtime");
    }
    const manifest = {
      ...item.manifest,
      workerBundleSha: workerSha,
      ...(declaredDependency ? { dependency: {
        ...declaredDependency,
        installRuntime,
        reusePolicy: declaredDependency.reusePolicy ?? "revision",
      } } : {}),
    } as SpriteBaselineManifest;
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
