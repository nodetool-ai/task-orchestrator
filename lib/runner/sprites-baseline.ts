import { createHash } from "node:crypto";

import type { SpritesClient } from "./sprites-client";
import { bootstrapSprite } from "./sprites-bootstrap";
import { logSpritePhase, spriteLog } from "./sprites-log";

/** Bump when the on-Sprite manifest format or verification contract changes. */
export const SPRITE_BASELINE_SCHEMA_VERSION = 1;
export const SPRITE_CHECKOUT_PATH = "/home/user/session/repo";
export const SPRITE_NPM_CACHE_PATH = "/home/user/session/.npm-cache";
export const SPRITE_BASELINE_DIR = "/home/user/session/.sprite-baseline";

export interface SpriteDependencyManifest {
  repository: string;
  revision?: string;
  lockfile: { path: string; sha256: string };
  packageManifests: Array<{ path: string; sha256: string }>;
  packageManager: string;
  packageManagerVersion: string;
  installOptions: string[];
  /** Inputs used by install scripts; source changes conservatively invalidate. */
  installScriptInputs?: Array<{ path: string; sha256: string }>;
  /** Run-local conservative invalidation for tracked source edits. */
  sourceChangesSha?: string;
}

export interface SpriteBaselineManifest {
  schemaVersion: number;
  workerBundleSha: string;
  nodeVersion: string;
  codexVersion: string;
  platform: string;
  architecture: string;
  systemToolsVersion: string;
  dependency?: SpriteDependencyManifest;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function canonicalBaselineManifest(manifest: SpriteBaselineManifest): string {
  return canonical(manifest);
}

export function baselineFingerprint(manifest: SpriteBaselineManifest): string {
  return createHash("sha256").update(canonicalBaselineManifest(manifest)).digest("hex");
}

export function dependencyFingerprint(manifest: SpriteDependencyManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}

/** Shell-safe script for public repository bootstrap; installation errors propagate. */
export function dependencyPreparationCommand(opts: {
  remote: string; checkoutPath?: string; branch?: string;
  packageManager?: "npm" | "pnpm" | "yarn"; installOptions?: string[];
}): string {
  if (opts.packageManager && opts.packageManager !== "npm") throw new Error("Sprite dependency baselines currently support npm only");
  const path = opts.checkoutPath ?? SPRITE_CHECKOUT_PATH;
  return ["set -eu", `mkdir -p ${shellQuote(SPRITE_NPM_CACHE_PATH)}`,
    `git clone --filter=blob:none -- ${shellQuote(opts.remote)} ${shellQuote(path)}`,
    ...(opts.branch ? [`git -C ${shellQuote(path)} checkout --detach ${shellQuote(opts.branch)}`] : []),
    `cd ${shellQuote(path)}`,
    `npm ci --cache ${shellQuote(SPRITE_NPM_CACHE_PATH)} ${(opts.installOptions ?? ["--no-audit", "--no-fund"]).map(shellQuote).join(" ")}`,
  ].join("\n");
}

function nodeCommand(program: string): string { return `node -e ${shellQuote(program)}`; }

async function execChecked(client: SpritesClient, name: string, cmd: string, label: string,
  options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<void> {
  await logSpritePhase(label, { spriteName: name }, async () => {
    const result = await client.exec(name, { cmd, ...options });
    if (result.exitCode !== 0) throw Object.assign(new Error(`${label} failed (exit ${result.exitCode})`), { exitCode: result.exitCode });
  });
}

export async function writeBaselineManifest(client: SpritesClient, spriteName: string, manifest: SpriteBaselineManifest): Promise<void> {
  const data = JSON.stringify({ ...manifest, fingerprint: baselineFingerprint(manifest) });
  await execChecked(client, spriteName, nodeCommand(`const fs=require('fs');fs.mkdirSync(${JSON.stringify(SPRITE_BASELINE_DIR)},{recursive:true});fs.writeFileSync(${JSON.stringify(SPRITE_BASELINE_DIR + '/manifest.json')},${JSON.stringify(data)},{mode:0o444});`), "baseline manifest write");
}

export async function writeDependencyManifest(client: SpritesClient, spriteName: string, manifest: SpriteDependencyManifest): Promise<string> {
  const fingerprint = dependencyFingerprint(manifest);
  await execChecked(client, spriteName, nodeCommand(`const fs=require('fs');fs.mkdirSync(${JSON.stringify(SPRITE_BASELINE_DIR)},{recursive:true});fs.writeFileSync(${JSON.stringify(SPRITE_BASELINE_DIR + '/dependency.json')},${JSON.stringify(JSON.stringify(manifest))},{mode:0o444});fs.writeFileSync(${JSON.stringify(SPRITE_CHECKOUT_PATH + '/.sprite-dependency-fingerprint')},${JSON.stringify(fingerprint)});`), "dependency manifest write");
  return fingerprint;
}

/** Validates files and runtime inputs, not an asserted fingerprint marker. */
export function dependencyVerificationProgram(manifest: SpriteDependencyManifest, checkoutPath = SPRITE_CHECKOUT_PATH): string {
  return `const fs=require('fs'),crypto=require('crypto'),path=require('path'),cp=require('child_process');
const m=${JSON.stringify(manifest)},root=${JSON.stringify(checkoutPath)};
for(const file of [m.lockfile,...m.packageManifests,...(m.installScriptInputs||[])]) {
 const target=path.resolve(root,file.path); if(!target.startsWith(path.resolve(root)+path.sep)) throw Error('invalid dependency path');
 if(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==file.sha256) throw Error('dependency input mismatch');
}
if(m.revision && cp.execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==m.revision) throw Error('revision mismatch');
if(cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim()!==m.packageManagerVersion) throw Error('npm version mismatch');`;
}

export async function verifyBaseline(client: SpritesClient, spriteName: string, manifest: SpriteBaselineManifest, codexBinary: string): Promise<void> {
  const expected = { ...manifest, fingerprint: baselineFingerprint(manifest) };
  const program = `const fs=require('fs'),crypto=require('crypto'),cp=require('child_process');
const expected=${JSON.stringify(expected)};
const canonical=${canonical.toString()};
const stored=JSON.parse(fs.readFileSync(${JSON.stringify(SPRITE_BASELINE_DIR + '/manifest.json')},'utf8'));
if(canonical(stored)!==canonical(expected)) throw Error('baseline manifest mismatch');
if(crypto.createHash('sha1').update(fs.readFileSync('/home/user/worker/dist/run-worker.js')).digest('hex')!==expected.workerBundleSha) throw Error('worker digest mismatch');
if(process.version!==expected.nodeVersion||process.platform!==expected.platform||process.arch!==expected.architecture) throw Error('runtime mismatch');
const codex=cp.execFileSync(${JSON.stringify(codexBinary)},['--version'],{encoding:'utf8'}).trim();
if(codex!=='codex-cli '+expected.codexVersion && codex!==expected.codexVersion) throw Error('Codex version mismatch');
fs.accessSync('/home/user/session',fs.constants.R_OK|fs.constants.W_OK);`;
  await execChecked(client, spriteName, nodeCommand(program), "baseline verification");
  // Versioned recipe v1 relies on these base-image tools; changing the recipe
  // requires a new systemToolsVersion and rebuilds unused entries.
  await execChecked(client, spriteName, "set -eu\ncommand -v git\ncommand -v curl\ncommand -v tar\ncommand -v npm", "system tools verification");
  if (manifest.dependency) {
    await execChecked(client, spriteName, nodeCommand(dependencyVerificationProgram(manifest.dependency)), "dependency verification");
  }
}

export async function prepareSpriteBaseline(client: SpritesClient, spriteName: string, opts: {
  manifest: SpriteBaselineManifest; bundleUrl: string; codexBinary?: string;
  dependency?: { remote: string; branch?: string; packageManager?: "npm" | "pnpm" | "yarn"; installOptions?: string[] };
}): Promise<{ checkpointId: string; fingerprint: string }> {
  if (!client.listServices) throw new Error("Sprite baselines require service inspection");
  if ((await client.listServices(spriteName)).length) throw new Error("Baseline Sprite must have no service definitions");
  await logSpritePhase("baseline_bootstrap", { spriteName, fingerprint: baselineFingerprint(opts.manifest) }, () =>
    bootstrapSprite(client, spriteName, { workerSha: opts.manifest.workerBundleSha, bundleUrl: opts.bundleUrl, codexBinary: opts.codexBinary, checkpoint: false }));
  await execChecked(client, spriteName, `mkdir -p ${SPRITE_BASELINE_DIR} ${SPRITE_NPM_CACHE_PATH}`, "baseline directory creation");
  const dependency = opts.manifest.dependency;
  if (dependency) {
    if (!opts.dependency || opts.dependency.remote !== dependency.repository || opts.dependency.branch !== dependency.revision) throw new Error("Dependency preparation configuration differs from manifest");
    // The token exists only in this bounded git exec, never a service definition
    // or a credential file. Installation runs in a separate exec without it.
    const helper = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
    const clone = ["set -eu", `git -c credential.helper=${shellQuote(helper)} clone --filter=blob:none -- ${shellQuote(dependency.repository)} ${shellQuote(SPRITE_CHECKOUT_PATH)}`,
      `git -C ${shellQuote(SPRITE_CHECKOUT_PATH)} checkout --detach ${shellQuote(dependency.revision!)}`].join("\n");
    await execChecked(client, spriteName, clone, "baseline checkout", { timeoutMs: 10 * 60_000,
      env: process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {} });
    await execChecked(client, spriteName, nodeCommand(dependencyVerificationProgram(dependency)), "dependency input verification");
    await execChecked(client, spriteName, `cd ${shellQuote(SPRITE_CHECKOUT_PATH)} && npm ci --cache ${shellQuote(SPRITE_NPM_CACHE_PATH)} ${dependency.installOptions.map(shellQuote).join(' ')}`,
      "baseline dependency installation", { timeoutMs: 20 * 60_000 });
    await writeDependencyManifest(client, spriteName, dependency);
  } else if (opts.dependency) throw new Error("Dependency preparation requires a manifest");
  await writeBaselineManifest(client, spriteName, opts.manifest);
  await verifyBaseline(client, spriteName, opts.manifest, opts.codexBinary ?? "/home/user/worker/.codex/bin/codex");
  if ((await client.listServices(spriteName)).length) throw new Error("Baseline acquired a service definition during preparation");
  await execChecked(client, spriteName, "sync", "baseline flush");
  const fingerprint = baselineFingerprint(opts.manifest);
  const checkpoint = await logSpritePhase("baseline_checkpoint", { spriteName, fingerprint }, () => client.checkpoint(spriteName, `baseline ${fingerprint}`));
  spriteLog("sprites_baseline_checkpoint_created", { spriteName, fingerprint, checkpointId: checkpoint.id });
  return { checkpointId: checkpoint.id, fingerprint };
}
