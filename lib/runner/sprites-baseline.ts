import { createHash } from "node:crypto";

import type { SpritesClient } from "./sprites-client";
import { bootstrapSprite } from "./sprites-bootstrap";
import { logSpritePhase, spriteLog } from "./sprites-log";

/** Bump when the on-Sprite manifest format or verification contract changes. */
export const SPRITE_BASELINE_SCHEMA_VERSION = 1;
export const SPRITE_CHECKOUT_PATH = "/home/user/session/repo";
export const SPRITE_NPM_CACHE_PATH = "/home/user/session/.npm-cache";
export const SPRITE_BASELINE_DIR = "/home/user/session/.sprite-baseline";
export const SPRITE_NPM_CONFIG_ARGS = ["--userconfig=/dev/null", "--globalconfig=/nonexistent/task-orchestrator-empty-npmrc"] as const;

export interface SpriteDependencyManifest {
  repository: string;
  revision?: string;
  lockfile: { path: string; sha256: string };
  packageManifests: Array<{ path: string; sha256: string }>;
  packageManager: string;
  packageManagerVersion: string;
  installOptions: string[];
  /** Root npm configuration, or null to assert that it is absent. */
  npmConfig?: { path: ".npmrc"; sha256: string } | null;
  /** Runtime ABI used by the installed dependency tree. */
  installRuntime?: { nodeVersion: string; platform: string; architecture: string };
  /**
   * `revision` is the conservative default: any source revision or tracked
   * edit can affect an arbitrary lifecycle script. `inputs` permits reuse
   * across source changes after the operator explicitly declares every extra
   * lifecycle-script input (an empty array asserts there are none).
   */
  reusePolicy?: "revision" | "inputs";
  /** Inputs used by install scripts in addition to package manifests. */
  installScriptInputs?: Array<{ path: string; sha256: string }>;
  /** Run-local conservative invalidation for tracked source edits. */
  sourceChangesSha?: string;
  /** Repository-owned preparation/build steps, supplied by the scoped baseline
   * profile. Commands run only during baseline creation or dependency repair. */
  setupCommands?: string[];
  buildCommands?: string[];
  /** Non-mutating project checks run after preparation and on restore. */
  readinessCommands?: string[];
  /** Workspace package manifests whose declared dist outputs are intentionally
   * not checked. Their manifest digests remain required and verified. */
  workspaceOutputExclusions?: string[];
  minimumGitHistoryDepth?: number;
  baseRef?: string;
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

const controlledNpmProgram = `const cp=require('child_process'),env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_/i.test(key)&&key!=='NODE_ENV')),args=['ci',...${JSON.stringify(SPRITE_NPM_CONFIG_ARGS)},...process.argv.slice(1)],result=cp.spawnSync('npm',args,{env,stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);`;

/** Run npm with repository config represented by the manifest, never ambient
 * user/global config or inherited NPM_CONFIG_* overrides. */
export function controlledNpmCiCommand(cachePath: string, installOptions: string[]): string {
  return nodeCommand(controlledNpmProgram) + ` -- ${["--cache", cachePath, ...installOptions].map(shellQuote).join(" ")}`;
}

export function canonicalBaselineManifest(manifest: SpriteBaselineManifest): string {
  return canonical(manifest);
}

export function baselineFingerprint(manifest: SpriteBaselineManifest): string {
  return createHash("sha256").update(canonicalBaselineManifest(manifest)).digest("hex");
}

export function dependencyFingerprint(manifest: SpriteDependencyManifest): string {
  const policy = manifest.reusePolicy ?? "revision";
  if (policy === "inputs" && !Array.isArray(manifest.installScriptInputs)) {
    throw new Error("Input-scoped dependency reuse requires installScriptInputs (use [] to assert none)");
  }
  if (policy === "inputs" && manifest.npmConfig === undefined) {
    throw new Error("Input-scoped dependency reuse requires npmConfig (use null to assert .npmrc is absent)");
  }
  const identity = {
    repository: manifest.repository,
    lockfile: manifest.lockfile,
    packageManifests: manifest.packageManifests,
    packageManager: manifest.packageManager,
    packageManagerVersion: manifest.packageManagerVersion,
    installOptions: manifest.installOptions,
    ...(manifest.npmConfig !== undefined ? { npmConfig: manifest.npmConfig } : {}),
    ...(manifest.installRuntime ? { installRuntime: manifest.installRuntime } : {}),
    reusePolicy: policy,
    ...(manifest.installScriptInputs ? { installScriptInputs: manifest.installScriptInputs } : {}),
    ...(manifest.setupCommands ? { setupCommands: manifest.setupCommands } : {}),
    ...(manifest.workspaceOutputExclusions !== undefined
      ? { workspaceOutputExclusions: manifest.workspaceOutputExclusions }
      : {}),
    ...(policy === "revision" ? {
      ...(manifest.revision ? { revision: manifest.revision } : {}),
      ...(manifest.sourceChangesSha ? { sourceChangesSha: manifest.sourceChangesSha } : {}),
    } : {}),
  };
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

/** Build outputs follow source state independently from the dependency tree. */
export function buildFingerprint(manifest: SpriteDependencyManifest): string {
  return createHash("sha256").update(canonical({
    revision: manifest.revision ?? null,
    sourceChangesSha: manifest.sourceChangesSha ?? null,
    buildCommands: manifest.buildCommands ?? [],
  })).digest("hex");
}

/** Shell-safe script for public repository bootstrap; installation errors propagate. */
export function dependencyPreparationCommand(opts: {
  remote: string; checkoutPath?: string; branch?: string;
  packageManager?: "npm" | "pnpm" | "yarn"; installOptions?: string[];
}): string {
  if (opts.packageManager && opts.packageManager !== "npm") throw new Error("Sprite dependency baselines currently support npm only");
  const path = opts.checkoutPath ?? SPRITE_CHECKOUT_PATH;
  return ["set -eu", `mkdir -p ${shellQuote(SPRITE_NPM_CACHE_PATH)} ${shellQuote(SPRITE_BASELINE_DIR)}`,
    `git clone --filter=blob:none -- ${shellQuote(opts.remote)} ${shellQuote(path)}`,
    ...(opts.branch ? [`git -C ${shellQuote(path)} checkout --detach ${shellQuote(opts.branch)}`] : []),
    `cd ${shellQuote(path)}`,
    controlledNpmCiCommand(SPRITE_NPM_CACHE_PATH, opts.installOptions ?? ["--no-audit", "--no-fund"]),
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
  const receipt = JSON.stringify({ fingerprint });
  const build = buildFingerprint(manifest);
  await execChecked(client, spriteName, nodeCommand(String.raw`const fs=require('fs'),cp=require('child_process'),path=require('path');fs.mkdirSync(${JSON.stringify(SPRITE_BASELINE_DIR)},{recursive:true});const reported=cp.execFileSync('git',['-C',${JSON.stringify(SPRITE_CHECKOUT_PATH)},'rev-parse','--git-path','info/exclude'],{encoding:'utf8'}).trim(),exclude=path.resolve(${JSON.stringify(SPRITE_CHECKOUT_PATH)},reported),patterns=['.sprite-dependency-*','.sprite-build-fingerprint*'],existing=fs.readFileSync(exclude,'utf8'),missing=patterns.filter(x=>!existing.split(/\r?\n/).includes(x));if(missing.length)fs.appendFileSync(exclude,(existing&&!existing.endsWith('\n')?'\n':'')+missing.join('\n')+'\n');fs.writeFileSync(${JSON.stringify(SPRITE_BASELINE_DIR + '/dependency.json')},${JSON.stringify(JSON.stringify(manifest))},{mode:0o444});fs.writeFileSync(${JSON.stringify(SPRITE_CHECKOUT_PATH + '/.sprite-dependency-fingerprint')},${JSON.stringify(fingerprint)});fs.writeFileSync(${JSON.stringify(SPRITE_CHECKOUT_PATH + '/.sprite-dependency-manifest.json')},${JSON.stringify(receipt)});fs.writeFileSync(${JSON.stringify(SPRITE_CHECKOUT_PATH + '/.sprite-build-fingerprint')},${JSON.stringify(build)});`), "dependency manifest write");
  return fingerprint;
}

/** Validates files and runtime inputs, not an asserted fingerprint marker. */
export function dependencyVerificationProgram(manifest: SpriteDependencyManifest, checkoutPath = SPRITE_CHECKOUT_PATH, readiness = true): string {
  return `(function(){const fs=require('fs'),crypto=require('crypto'),path=require('path'),cp=require('child_process');
const m=${JSON.stringify(manifest)},root=${JSON.stringify(checkoutPath)};
for(const file of [m.lockfile,...m.packageManifests,...(m.installScriptInputs||[]),...(m.npmConfig?[m.npmConfig]:[])]) {
 const target=path.resolve(root,file.path); if(!target.startsWith(path.resolve(root)+path.sep)) throw Error('invalid dependency path');
 if(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==file.sha256) throw Error('dependency input mismatch');
}
if(m.npmConfig===null&&fs.existsSync(path.join(root,'.npmrc'))) throw Error('dependency input mismatch: unexpected .npmrc');
if(m.revision && cp.execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==m.revision) throw Error('revision mismatch');
const npmEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_/i.test(key)&&key!=='NODE_ENV'));
if(cp.execFileSync('npm',[...${JSON.stringify(SPRITE_NPM_CONFIG_ARGS)},'--version'],{encoding:'utf8',env:npmEnv}).trim()!==m.packageManagerVersion) throw Error('npm version mismatch');
if(m.installRuntime&&(process.version!==m.installRuntime.nodeVersion||process.platform!==m.installRuntime.platform||process.arch!==m.installRuntime.architecture)) throw Error('dependency runtime mismatch');
const depth=Number(cp.execFileSync('git',['-C',root,'rev-list','--count','HEAD'],{encoding:'utf8'}).trim());
if(m.minimumGitHistoryDepth&&depth<m.minimumGitHistoryDepth) throw Error('git history too shallow: '+depth+' commits, need '+m.minimumGitHistoryDepth);
if(m.baseRef){try{cp.execFileSync('git',['-C',root,'merge-base','HEAD',m.baseRef],{stdio:'ignore'});}catch{throw Error('merge base unavailable for '+m.baseRef+'; fetch sufficient history');}}
if(!${JSON.stringify(readiness)}) return;
if(!fs.existsSync(path.join(root,'node_modules'))) throw Error('dependencies missing: node_modules is absent');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const declared={...(pkg.dependencies||{}),...(pkg.devDependencies||{}),...(pkg.optionalDependencies||{})};
for(const tool of ['typescript','tsx','vitest']) if(declared[tool]) {try{cp.execFileSync('node',['-e','require.resolve('+JSON.stringify(tool+'/package.json')+')'],{cwd:root,stdio:'ignore'});}catch{throw Error('declared tool unavailable: '+tool);}}
if(declared['better-sqlite3']) {try{cp.execFileSync('node',['-e',"const D=require('better-sqlite3');const d=new D(':memory:');d.close()"],{cwd:root,stdio:'ignore'});}catch{throw Error('native binding unavailable: better-sqlite3 (install scripts may have been skipped)');}}
const outputExclusions=new Set(m.workspaceOutputExclusions||[]);
for(const rel of m.packageManifests.filter(x=>x.path!=='package.json'&&!outputExclusions.has(x.path)).map(x=>x.path)) {const p=JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));for(const field of ['main','module','types']) {const out=p[field];if(typeof out==='string'&&/(^|\\/)dist\\//.test(out)&&!fs.existsSync(path.resolve(path.dirname(path.join(root,rel)),out))) throw Error('workspace build output missing: '+rel+' '+field+' -> '+out);}}
for(const command of (m.readinessCommands||[])){const result=cp.spawnSync(command,{cwd:root,shell:true,stdio:'pipe',encoding:'utf8',timeout:120000});if(result.status!==0) throw Error('readiness command failed: '+command+'\\n'+String(result.stderr||result.stdout||'').slice(-2000));}})();`;
}

async function runRepositoryCommands(client: SpritesClient, spriteName: string, commands: string[] | undefined, label: string): Promise<void> {
  for (const [index, command] of (commands ?? []).entries()) {
    await execChecked(client, spriteName, `cd ${shellQuote(SPRITE_CHECKOUT_PATH)} && ${command}`, `${label} ${index + 1}`, { timeoutMs: 20 * 60_000 });
  }
}

export async function verifyBaseline(client: SpritesClient, spriteName: string, manifest: SpriteBaselineManifest, codexBinary: string): Promise<void> {
  const expected = { ...manifest, fingerprint: baselineFingerprint(manifest) };
  const program = `const fs=require('fs'),crypto=require('crypto'),cp=require('child_process');
const expected=${JSON.stringify(expected)};
const canonical=${canonical.toString()};
const stored=JSON.parse(fs.readFileSync(${JSON.stringify(SPRITE_BASELINE_DIR + '/manifest.json')},'utf8'));
if(canonical(stored)!==canonical(expected)) throw Error('baseline manifest mismatch');
const bundleHash=crypto.createHash('sha1');
for(const [name,file] of [['dist/run-worker.js','/home/user/worker/dist/run-worker.js'],['codeact/emscripten-module.wasm','/home/user/worker/codeact/emscripten-module.wasm'],['codeact/emscripten-module.wasm.sha256','/home/user/worker/codeact/emscripten-module.wasm.sha256'],['codeact/thread-worker.js','/home/user/worker/codeact/thread-worker.js'],['process-supervisor.py','/home/user/worker/process-supervisor.py']]) bundleHash.update(name).update('\\0').update(fs.readFileSync(file));
if(bundleHash.digest('hex')!==expected.workerBundleSha) throw Error('worker bundle digest mismatch');
const wasm=fs.readFileSync('/home/user/worker/codeact/emscripten-module.wasm');
if(!WebAssembly.validate(wasm)) throw Error('CodeAct WASM is not executable');
if(process.version!==expected.nodeVersion||process.platform!==expected.platform||process.arch!==expected.architecture) throw Error('runtime mismatch');
const codex=cp.execFileSync(${JSON.stringify(codexBinary)},['--version'],{encoding:'utf8'}).trim();
if(codex!=='codex-cli '+expected.codexVersion && codex!==expected.codexVersion) throw Error('Codex version mismatch');
fs.accessSync('/home/user/session',fs.constants.R_OK|fs.constants.W_OK);`;
  await execChecked(client, spriteName, nodeCommand(program), "baseline verification");
  // Versioned recipe v1 relies on these base-image tools; changing the recipe
  // requires a new systemToolsVersion and rebuilds unused entries.
  await execChecked(client, spriteName, "set -eu\ncommand -v git\ncommand -v curl\ncommand -v tar\ncommand -v npm\ncommand -v python3", "system tools verification");
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
    bootstrapSprite(client, spriteName, { workerSha: opts.manifest.workerBundleSha, bundleUrl: opts.bundleUrl, nodeVersion: opts.manifest.nodeVersion, codexBinary: opts.codexBinary, checkpoint: false }));
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
    await execChecked(client, spriteName, nodeCommand(dependencyVerificationProgram(dependency, SPRITE_CHECKOUT_PATH, false)), "dependency input verification");
    await runRepositoryCommands(client, spriteName, dependency.setupCommands, "repository setup");
    await execChecked(client, spriteName, `cd ${shellQuote(SPRITE_CHECKOUT_PATH)} && ${controlledNpmCiCommand(SPRITE_NPM_CACHE_PATH, dependency.installOptions)}`,
      "baseline dependency installation", { timeoutMs: 20 * 60_000 });
    await runRepositoryCommands(client, spriteName, dependency.buildCommands, "repository build");
  } else if (opts.dependency) throw new Error("Dependency preparation requires a manifest");
  await writeBaselineManifest(client, spriteName, opts.manifest);
  await verifyBaseline(client, spriteName, opts.manifest, opts.codexBinary ?? "/home/user/worker/.codex/bin/codex");
  if (dependency) await writeDependencyManifest(client, spriteName, dependency);
  if ((await client.listServices(spriteName)).length) throw new Error("Baseline acquired a service definition during preparation");
  await execChecked(client, spriteName, "sync", "baseline flush");
  const fingerprint = baselineFingerprint(opts.manifest);
  const checkpoint = await logSpritePhase("baseline_checkpoint", { spriteName, fingerprint }, () => client.checkpoint(spriteName, `baseline ${fingerprint}`));
  spriteLog("sprites_baseline_checkpoint_created", { spriteName, fingerprint, checkpointId: checkpoint.id });
  return { checkpointId: checkpoint.id, fingerprint };
}
