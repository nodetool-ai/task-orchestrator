import { createHash } from "node:crypto";
import { access, appendFile, lstat, readFile, readlink, writeFile, rm, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  SPRITE_BASELINE_DIR,
  SPRITE_NPM_CACHE_PATH,
  SPRITE_NPM_CONFIG_ARGS,
  buildFingerprint,
  dependencyFingerprint,
  dependencyVerificationProgram,
  type SpriteDependencyManifest,
} from "../runner/sprites-baseline";
import { sh } from "../repo-checkout";
import { timeRunnerPhase, recordRunnerEvent } from "../runner/telemetry";
import { spriteLog, spriteWorkerLogContext, logSpritePhase } from "../runner/sprites-log";

const DEPENDENCY_MARKER = ".sprite-dependency-fingerprint";
const DEPENDENCY_RECEIPT = ".sprite-dependency-manifest.json";
const BUILD_RECEIPT = ".sprite-build-fingerprint";
function controlledNpmEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== "NODE_ENV")) as NodeJS.ProcessEnv;
}

async function inputDigest(checkoutDir: string, path: string): Promise<string> {
  const target = resolve(checkoutDir, path);
  if (!target.startsWith(resolve(checkoutDir) + sep)) throw new Error("Dependency path escapes checkout");
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

async function optionalDigest(checkoutDir: string, path: ".npmrc"): Promise<{ path: ".npmrc"; sha256: string } | null> {
  try { return { path, sha256: await inputDigest(checkoutDir, path) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function dependencyInputsMatch(manifest: SpriteDependencyManifest, checkoutDir: string): Promise<boolean> {
  try {
    for (const file of [manifest.lockfile, ...manifest.packageManifests, ...(manifest.installScriptInputs ?? []), ...(manifest.npmConfig ? [manifest.npmConfig] : [])]) {
      if (await inputDigest(checkoutDir, file.path) !== file.sha256) return false;
    }
    if (manifest.npmConfig === null && await access(join(checkoutDir, ".npmrc")).then(() => true, () => false)) return false;
    if ((manifest.reusePolicy ?? "revision") === "revision" && manifest.revision
      && (await sh(["git", "-C", checkoutDir, "rev-parse", "HEAD"], "/")).trim() !== manifest.revision) return false;
    return true;
  } catch { return false; }
}

async function sourceChangesDigest(checkoutDir: string): Promise<string | undefined> {
  const tracked = await sh(["git", "-C", checkoutDir, "diff", "--binary", "HEAD", "--", ".",
    ":(exclude).sprite-dependency-*", ":(exclude).sprite-build-fingerprint"], "/");
  const untracked = (await sh(["git", "-C", checkoutDir, "ls-files", "--others", "--exclude-standard", "-z"], "/"))
    .split("\0").filter((path) => path && !path.startsWith(".sprite-dependency-") && !path.startsWith(".sprite-build-fingerprint")).sort();
  if (!tracked && !untracked.length) return undefined;
  const hash = createHash("sha256").update(tracked);
  for (const path of untracked) {
    const target = resolve(checkoutDir, path);
    const stat = await lstat(target);
    hash.update("\0").update(path).update("\0");
    if (stat.isSymbolicLink()) hash.update("symlink\0").update(await readlink(target));
    else if (stat.isFile()) hash.update(await readFile(target));
    else throw new Error(`Unsupported untracked source type: ${path}`);
  }
  return hash.digest("hex");
}

async function selectedManifest(template: SpriteDependencyManifest, checkoutDir: string): Promise<SpriteDependencyManifest> {
  const hash = async (file: { path: string }) => ({ path: file.path, sha256: await inputDigest(checkoutDir, file.path) });
  const sourceChangesSha = await sourceChangesDigest(checkoutDir);
  return {
    ...template,
    revision: (await sh(["git", "-C", checkoutDir, "rev-parse", "HEAD"], "/")).trim(),
    ...(sourceChangesSha ? { sourceChangesSha } : { sourceChangesSha: undefined }),
    packageManagerVersion: (await sh(["npm", ...SPRITE_NPM_CONFIG_ARGS, "--version"], checkoutDir, controlledNpmEnv())).trim(),
    ...(template.installRuntime ? { installRuntime: {
      nodeVersion: process.version, platform: process.platform, architecture: process.arch,
    } } : {}),
    lockfile: await hash(template.lockfile),
    packageManifests: await Promise.all(template.packageManifests.map(hash)),
    ...(template.installScriptInputs ? { installScriptInputs: await Promise.all(template.installScriptInputs.map(hash)) } : {}),
    ...(template.npmConfig !== undefined ? { npmConfig: await optionalDigest(checkoutDir, ".npmrc") } : {}),
  };
}

async function installReceiptExcludes(checkoutDir: string): Promise<void> {
  const reportedPath = (await sh(["git", "-C", checkoutDir, "rev-parse", "--git-path", "info/exclude"], "/")).trim();
  const excludePath = resolve(checkoutDir, reportedPath);
  const current = await readFile(excludePath, "utf8").catch(() => "");
  const patterns = [".sprite-dependency-*", ".sprite-build-fingerprint*"];
  const missing = patterns.filter((path) => !current.split(/\r?\n/).includes(path));
  if (missing.length) await appendFile(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

async function readReceiptFingerprint(path: string): Promise<string> {
  try {
    const receipt = JSON.parse(await readFile(path, "utf8")) as { fingerprint?: unknown };
    return typeof receipt.fingerprint === "string" ? receipt.fingerprint : "";
  } catch { return ""; }
}

async function invalidateReceipts(checkoutDir: string, dependency = true): Promise<void> {
  await rm(join(checkoutDir, BUILD_RECEIPT), { force: true });
  if (dependency) await Promise.all([
    rm(join(checkoutDir, DEPENDENCY_MARKER), { force: true }),
    rm(join(checkoutDir, DEPENDENCY_RECEIPT), { force: true }),
  ]);
}

async function writeReceipt(path: string, content: string): Promise<void> {
  await writeFile(`${path}.tmp`, content);
  await rename(`${path}.tmp`, path);
}

/** The dependency and build receipts are independent: source-only changes can
 * rebuild repository outputs while preserving a verified dependency tree. */
type DependencyOptions = { install?: (dir: string, args: string[]) => Promise<void>; manifest?: SpriteDependencyManifest };
export async function prepareSpriteDependencies(checkoutDir: string, opts: DependencyOptions = {}): Promise<"reused" | "installed" | "skipped"> {
  const context = spriteWorkerLogContext();
  if (process.env.TASK_ORCH_SPRITE_DEPENDENCY_REUSE !== "1") {
    if (context.spriteName) spriteLog("sprites_dependency_check_skipped", { ...context, reason: "no_dependency_baseline" }, "debug");
    return "skipped";
  }
  return logSpritePhase("project_dependencies", context, () => prepareSpriteDependenciesChecked(checkoutDir, opts));
}

async function prepareSpriteDependenciesChecked(checkoutDir: string, opts: DependencyOptions): Promise<"reused" | "installed"> {
  const context = spriteWorkerLogContext();
  const runId = typeof context.runId === "number" ? context.runId : undefined;
  const expected = process.env.TASK_ORCH_SPRITE_DEPENDENCY_FINGERPRINT?.trim();
  if (!expected) throw new Error("Sprite dependency baseline identity is missing");
  const template = opts.manifest ?? JSON.parse(await readFile(`${SPRITE_BASELINE_DIR}/dependency.json`, "utf8")) as SpriteDependencyManifest;
  if (template.packageManager !== "npm" || dependencyFingerprint(template) !== expected) throw new Error("Sprite dependency baseline manifest is invalid");
  await installReceiptExcludes(checkoutDir);

  const marker = join(checkoutDir, DEPENDENCY_MARKER);
  const receipt = join(checkoutDir, DEPENDENCY_RECEIPT);
  const buildReceipt = join(checkoutDir, BUILD_RECEIPT);
  const current = await selectedManifest(template, checkoutDir);
  const fingerprint = dependencyFingerprint(current);
  const savedMarker = (await readFile(marker, "utf8").catch(() => "")).trim();
  const savedReceipt = await readReceiptFingerprint(receipt);
  const hasTree = await access(join(checkoutDir, "node_modules")).then(() => true, () => false);
  const dependencyReady = savedMarker === fingerprint && savedReceipt === fingerprint && hasTree;
  const decision = { ...context, fingerprint, baselineFingerprint: expected, revision: current.revision,
    baselineRevision: template.revision, hasTree, hasReceipt: Boolean(savedMarker && savedReceipt) };
  let installed = false;

  if (!dependencyReady) {
    const reason = !hasTree ? "tree_missing"
      : current.lockfile.sha256 !== template.lockfile.sha256 ? "lockfile_changed"
      : JSON.stringify(current.npmConfig) !== JSON.stringify(template.npmConfig) ? "npm_config_changed"
      : current.packageManagerVersion !== template.packageManagerVersion ? "package_manager_changed"
      : current.installRuntime && JSON.stringify(current.installRuntime) !== JSON.stringify(template.installRuntime) ? "runtime_changed"
      : (template.reusePolicy ?? "revision") === "revision" && current.revision !== template.revision ? "revision_changed"
      : (template.reusePolicy ?? "revision") === "revision" && current.sourceChangesSha ? "tracked_source_changed"
      : fingerprint !== expected ? "dependency_inputs_changed"
      : !savedMarker || !savedReceipt ? "receipt_missing" : "receipt_mismatch";
    spriteLog("sprites_dependency_decision", { ...decision, reused: false, reason });
    await invalidateReceipts(checkoutDir);
    try {
      for (const command of template.setupCommands ?? []) await sh(["sh", "-lc", command], checkoutDir);
      await timeRunnerPhase("sprites_dependency_install", () =>
        (opts.install ?? (async (dir, args) => { await sh(["npm", "ci", ...SPRITE_NPM_CONFIG_ARGS, "--cache", SPRITE_NPM_CACHE_PATH, ...args], dir, controlledNpmEnv()); }))(checkoutDir, template.installOptions),
        { provider: "sprites", fields: { ...context, fingerprint } });
      installed = true;
    } catch (error) {
      await invalidateReceipts(checkoutDir);
      throw error;
    }
  } else {
    spriteLog("sprites_dependency_decision", { ...decision, reused: true, reason: "verified_receipt" });
  }

  const sourceFingerprint = buildFingerprint(current);
  const savedBuildFingerprint = (await readFile(buildReceipt, "utf8").catch(() => "")).trim();
  const shouldBuild = Boolean(template.buildCommands?.length) && (installed || savedBuildFingerprint !== sourceFingerprint);
  if (shouldBuild) {
    await invalidateReceipts(checkoutDir, false);
    try {
      for (const command of template.buildCommands ?? []) await sh(["sh", "-lc", command], checkoutDir);
    } catch (error) {
      await invalidateReceipts(checkoutDir, false);
      throw error;
    }
  }

  try {
    await sh(["node", "-e", dependencyVerificationProgram(current, checkoutDir)], checkoutDir);
    const after = await selectedManifest(template, checkoutDir);
    if (dependencyFingerprint(after) !== fingerprint) throw new Error("Dependency inputs changed during preparation");
    await writeReceipt(receipt, JSON.stringify({ fingerprint }));
    await writeReceipt(marker, fingerprint);
    await writeReceipt(buildReceipt, sourceFingerprint);
  } catch (error) {
    await invalidateReceipts(checkoutDir);
    throw error;
  }

  if (!installed) recordRunnerEvent("sprites_dependency_reused", { provider: "sprites", runId, fields: { ...context, fingerprint } });
  recordRunnerEvent("sprites_project_ready", { provider: "sprites", runId, fields: { ...context, fingerprint, reused: !installed, rebuilt: shouldBuild } });
  return installed ? "installed" : "reused";
}
