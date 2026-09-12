import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { SPRITE_CODEX_VERSION, SPRITE_NODE_VERSION } from "./sprites-bootstrap";
import { getConfiguredSpriteBaselines } from "./sprites-pool-config";

const exec = promisify(execFile);
const inputPath = z.string().min(1).refine((path) =>
  !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
  !path.split("/").some((part) => part === ".." || part === "." || part === ""),
"Input paths must be relative repository files");
const uniqueInputPaths = z.array(inputPath).superRefine((paths, ctx) => {
  const seen = new Set<string>();
  for (const [index, path] of paths.entries()) {
    if (seen.has(path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "paths must be unique" });
    seen.add(path);
  }
});
const recipeSchema = z.object({
  repositoryId: z.string().min(1),
  repository: z.string().url(),
  allowedUserIds: z.array(z.number().int().positive()).min(1),
  target: z.number().int().positive().default(1),
  nodeVersion: z.string().default(SPRITE_NODE_VERSION),
  architecture: z.enum(["x64", "arm64"]).default("x64"),
  packageManagerVersion: z.string(),
  installOptions: z.array(z.string()).default(["--no-audit", "--no-fund", "--include=dev", "--include=optional"]),
  reusePolicy: z.enum(["revision", "inputs"]).default("revision"),
  installScriptInputs: z.array(inputPath).optional(),
  setupCommands: z.array(z.string()).optional(),
  buildCommands: z.array(z.string()).optional(),
  readinessCommands: z.array(z.string()).optional(),
  workspaceOutputExclusions: uniqueInputPaths.optional(),
  minimumGitHistoryDepth: z.number().int().positive().optional(),
  baseRef: z.string().optional(),
}).strict();

/** Produce a deployable baseline spec from immutable git blobs. No checkout,
 * install, network fetch, or execution of recipe commands takes place here. */
export async function generateSpriteBaseline(checkout: string, ref: string, input: unknown) {
  const recipe = recipeSchema.parse(input);
  if (recipe.reusePolicy === "inputs" && recipe.installScriptInputs === undefined) {
    throw new Error("inputs reuse requires an explicit installScriptInputs list; use [] only after auditing lifecycle scripts");
  }
  const git = async (args: string[]) => (await exec("git", ["-C", checkout, ...args], {
    encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
  })).stdout;
  const revision = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).toString().trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Baseline requires a SHA-1 git commit");
  const paths = (await git(["ls-tree", "-r", "-z", revision])).toString().split("\0");
  const modes = new Map(paths.filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    return [entry.slice(tab + 1), entry.slice(0, 6)] as const;
  }));
  const read = async (path: string) => {
    inputPath.parse(path);
    if (!/^100(644|755)$/.test(modes.get(path) ?? "")) {
      throw new Error(`Baseline input must be a tracked regular file at ${revision}: ${path}`);
    }
    return git(["show", `${revision}:${path}`]);
  };
  const lockBytes = await read("package-lock.json");
  const lock = JSON.parse(lockBytes.toString()) as { lockfileVersion?: number; packages?: Record<string, unknown> };
  if (![2, 3].includes(lock.lockfileVersion ?? 0) || !lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new Error("Baseline generation requires package-lock.json version 2 or 3 with workspace package entries");
  }
  const packagePaths = [...new Set(["package.json", ...Object.keys(lock.packages)
    .filter((path) => path && !path.split("/").includes("node_modules"))
    .map((path) => `${path}/package.json`)])].sort();
  const packagePathSet = new Set(packagePaths);
  for (const path of recipe.workspaceOutputExclusions ?? []) {
    if (path === "package.json" || !packagePathSet.has(path)) {
      throw new Error(`workspace output exclusion must reference a workspace package manifest at ${revision}: ${path}`);
    }
  }
  const digest = async (path: string) => ({ path, sha256: createHash("sha256").update(await read(path)).digest("hex") });
  const { repositoryId, allowedUserIds, target, nodeVersion, architecture, installScriptInputs, ...dependency } = recipe;
  const spec = {
    repositoryId, allowedUserIds, target,
    manifest: {
      schemaVersion: 1, nodeVersion, codexVersion: SPRITE_CODEX_VERSION,
      platform: "linux", architecture, systemToolsVersion: "sprite-base-v1",
      dependency: {
        ...dependency, revision, packageManager: "npm",
        lockfile: { path: "package-lock.json", sha256: createHash("sha256").update(lockBytes).digest("hex") },
        packageManifests: await Promise.all(packagePaths.map(digest)),
        npmConfig: modes.has(".npmrc") ? await digest(".npmrc") : null,
        ...(installScriptInputs !== undefined ? { installScriptInputs: await Promise.all([...new Set(installScriptInputs)].sort().map(digest)) } : {}),
      },
    },
  };
  // Use the production parser to reject unsupported options/unsafe remotes.
  // The real worker SHA is deliberately supplied by deployment, not the recipe.
  getConfiguredSpriteBaselines("0".repeat(40), JSON.stringify([spec]));
  return spec;
}
