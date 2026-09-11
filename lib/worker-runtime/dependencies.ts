import { createHash } from "node:crypto";
import { access, readFile, writeFile, rm, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { SPRITE_BASELINE_DIR, SPRITE_NPM_CACHE_PATH, dependencyFingerprint, dependencyVerificationProgram, type SpriteDependencyManifest } from "../runner/sprites-baseline";
import { sh } from "../repo-checkout";
import { timeRunnerPhase, recordRunnerEvent } from "../runner/telemetry";
import { spriteLog, spriteWorkerLogContext, logSpritePhase } from "../runner/sprites-log";

async function inputDigest(checkoutDir: string, path: string): Promise<string> {
  const target = resolve(checkoutDir, path);
  if (!target.startsWith(resolve(checkoutDir) + sep)) throw new Error("Dependency path escapes checkout");
  return createHash("sha256").update(await readFile(target)).digest("hex");
}

export async function dependencyInputsMatch(manifest: SpriteDependencyManifest, checkoutDir: string): Promise<boolean> {
  try {
    for (const file of [manifest.lockfile, ...manifest.packageManifests, ...(manifest.installScriptInputs ?? [])]) {
      if (await inputDigest(checkoutDir, file.path) !== file.sha256) return false;
    }
    if (manifest.revision && (await sh(["git", "-C", checkoutDir, "rev-parse", "HEAD"], "/")).trim() !== manifest.revision) return false;
    return true;
  } catch { return false; }
}

async function selectedManifest(template: SpriteDependencyManifest, checkoutDir: string): Promise<SpriteDependencyManifest> {
  const hash = async (file: { path: string }) => ({ path: file.path, sha256: await inputDigest(checkoutDir, file.path) });
  const dirty = await sh(["git", "-C", checkoutDir, "diff", "--binary", "HEAD", "--", ".", ":(exclude).sprite-dependency-*"], "/");
  return { ...template, revision: (await sh(["git", "-C", checkoutDir, "rev-parse", "HEAD"], "/")).trim(),
    ...(dirty ? { sourceChangesSha: createHash("sha256").update(dirty).digest("hex") } : {}),
    packageManagerVersion: (await sh(["npm", "--version"], checkoutDir)).trim(),
    lockfile: await hash(template.lockfile), packageManifests: await Promise.all(template.packageManifests.map(hash)),
    ...(template.installScriptInputs ? { installScriptInputs: await Promise.all(template.installScriptInputs.map(hash)) } : {}),
  };
}

/** The run-local receipt tracks the installed checkout, while the baseline
 * manifest remains immutable. Files are checked again after every checkout. */
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
  const marker = join(checkoutDir, ".sprite-dependency-fingerprint");
  const receipt = join(checkoutDir, ".sprite-dependency-manifest.json");
  const current = await selectedManifest(template, checkoutDir);
  const fingerprint = dependencyFingerprint(current);
  const savedMarker = await readFile(marker, "utf8").catch(() => "");
  const hasTree = await access(join(checkoutDir, "node_modules")).then(() => true, () => false);
  const decision = { ...context, fingerprint, baselineFingerprint: expected, revision: current.revision,
    baselineRevision: template.revision, hasTree, hasReceipt: Boolean(savedMarker.trim()) };
  if (savedMarker.trim() === fingerprint && hasTree) {
    await sh(["node", "-e", dependencyVerificationProgram(current, checkoutDir)], checkoutDir);
    spriteLog("sprites_dependency_decision", { ...decision, reused: true, reason: "verified_receipt" });
    recordRunnerEvent("sprites_dependency_reused", { provider: "sprites", runId, fields: { ...context, fingerprint } });
    recordRunnerEvent("sprites_project_ready", { provider: "sprites", runId, fields: { ...context, fingerprint, reused: true } });
    return "reused";
  }
  const reason = !hasTree ? "tree_missing"
    : current.lockfile.sha256 !== template.lockfile.sha256 ? "lockfile_changed"
    : current.revision !== template.revision ? "revision_changed"
    : current.packageManagerVersion !== template.packageManagerVersion ? "package_manager_changed"
    : current.sourceChangesSha ? "tracked_source_changed"
    : fingerprint !== expected ? "dependency_inputs_changed"
    : !savedMarker.trim() ? "receipt_missing" : "receipt_mismatch";
  spriteLog("sprites_dependency_decision", { ...decision, reused: false, reason });
  // npm ci can remove the prior tree before failing. Invalidate its receipt
  // before any installation so that a later retry cannot trust partial output.
  await rm(marker, { force: true });
  await rm(receipt, { force: true });
  for (const command of template.setupCommands ?? []) await sh(["sh", "-lc", command], checkoutDir);
  await timeRunnerPhase("sprites_dependency_install", () =>
    (opts.install ?? (async (dir, args) => { await sh(["npm", "ci", "--cache", SPRITE_NPM_CACHE_PATH, ...args], dir); }))(checkoutDir, template.installOptions),
    { provider: "sprites", fields: { ...context, fingerprint } });
  for (const command of template.buildCommands ?? []) await sh(["sh", "-lc", command], checkoutDir);
  await sh(["node", "-e", dependencyVerificationProgram(current, checkoutDir)], checkoutDir);
  const after = await selectedManifest(template, checkoutDir);
  if (dependencyFingerprint(after) !== fingerprint) throw new Error("Dependency inputs changed during installation");
  await writeFile(receipt, JSON.stringify(current));
  await writeFile(`${marker}.tmp`, fingerprint);
  await rename(`${marker}.tmp`, marker);
  recordRunnerEvent("sprites_project_ready", { provider: "sprites", runId, fields: { ...context, fingerprint, reused: false } });
  return "installed";
}
