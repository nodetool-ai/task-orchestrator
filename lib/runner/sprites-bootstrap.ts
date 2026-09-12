// lib/runner/sprites-bootstrap.ts
// Phase A bootstrap: install the worker bundle into a fresh sprite.
// See docs/sprites-migration-design.md §6 Phase A and docs/sprites-fix-prompts.md Prompt 8.
//
// The base image is standard; the worker bundle must be fetched at runtime.
// We intentionally skip `git clone` and `npm ci` here: the worker does its
// own checkout per turn today via containerCheckoutAt (see lib/worker/* and
// docs/runners/sprites.md Bootstrap). That keeps the sprite bootstrap fast and
// avoids baking a repo cache into the template — the per-turn fetch is the
// source of truth, the bundle is just the runner.

import type { SpritesClient } from "./sprites-client";

// The standalone worker bundle cannot carry the Codex SDK's platform package:
// it is a native ELF and is intentionally excluded by build-worker-standalone.
// Keep this pinned to the @openai/codex version brought in by the matching
// @openai/codex-sdk dependency in package.json.
export const SPRITE_CODEX_VERSION = "0.153.4";
export const SPRITE_CODEX_BINARY = "/home/user/worker/.codex/bin/codex";
export const SPRITE_CODEACT_WASM = "/home/user/worker/codeact/emscripten-module.wasm";
const SPRITE_CODEX_ROOT = "/home/user/worker/.codex";
// Match the repository's Node 22 toolchain. Sprite's floating default moved to
// Node 24/npm 12, whose remote-tarball policy rejects the SheetJS dependency.
export const SPRITE_NODE_VERSION = "v22.22.3";

export function spriteBootstrapComment(workerSha: string, nodeVersion = SPRITE_NODE_VERSION): string {
  return `bootstrap ${workerSha} node ${nodeVersion}`;
}

export function spriteNodeSetupCommand(version = SPRITE_NODE_VERSION): string {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("Sprite Node version must be an exact vX.Y.Z release");
  // Sprite's node/npm/npx shims activate this NVM default on every invocation,
  // including fresh execs and agent login shells. An exec-local `nvm use` alone
  // would leave later commands on the base image's Node/npm versions.
  return `bash -c ${shellQuote([
    "set -e",
    'export NVM_DIR="/.sprite/languages/node/nvm"',
    '. "$NVM_DIR/nvm.sh" --no-use',
    `nvm install ${shellQuote(version)}`,
    `nvm alias default ${shellQuote(version)}`,
    `test "$(node --version)" = ${shellQuote(version)}`,
    "npm --version",
  ].join("\n"))}`;
}

export class SpritesBootstrapError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "SpritesBootstrapError";
  }
}

export function spriteSwapSetupCommand(swapMb: number): string {
  if (!Number.isSafeInteger(swapMb) || swapMb <= 0) throw new Error("Sprite swap size must be a positive integer MiB value");
  // Sprite's persistent root is overlayfs, which rejects swap files even after
  // mkswap. /tmp is a dedicated ext4 volume and supports swapon. Use dd rather
  // than fallocate so every block is materialized (validated on a live Sprite).
  const swapFile = "/tmp/task-orchestrator.swap";
  return [
    "set -eu",
    `swap_file=${shellQuote(swapFile)}`,
    `swap_mb=${swapMb}`,
    'exec 9>"$swap_file.lock"',
    "flock -x 9",
    'expected_bytes=$((swap_mb * 1024 * 1024))',
    'swap_dir=${swap_file%/*}',
    'mount_target=$(findmnt -n -o TARGET --target "$swap_dir" 2>/dev/null || true)',
    "swap_alias=",
    'case "$mount_target" in',
    '  ""|/) ;;',
    '  *) case "$swap_file" in "$mount_target"/*) swap_alias="/${swap_file#"$mount_target"/}" ;; esac ;;',
    "esac",
    "swap_is_active() {",
    "  while read -r candidate _; do",
    '    [ "$candidate" = Filename ] && continue',
    '    [ "$candidate" = "$swap_file" ] && return 0',
    '    [ -n "$swap_alias" ] && [ "$candidate" = "$swap_alias" ] && return 0',
    '    [ -e "$candidate" ] && [ -e "$swap_file" ] && [ "$candidate" -ef "$swap_file" ] && return 0',
    "  done < /proc/swaps",
    "  return 1",
    "}",
    'actual_bytes=$(stat -c %s "$swap_file" 2>/dev/null || echo 0)',
    'if [ "$actual_bytes" -ne "$expected_bytes" ]; then',
    "  if swap_is_active; then",
    '    if ! sudo -n swapoff "$swap_file"; then',
    '      echo "cannot resize active swap: swapoff failed for $swap_file" >&2',
    "      exit 1",
    "    fi",
    "    if swap_is_active; then",
    '      echo "cannot resize active swap: $swap_file remains active after swapoff" >&2',
    "      exit 1",
    "    fi",
    "  fi",
    '  sudo -n rm -f "$swap_file"',
    '  sudo -n dd if=/dev/zero of="$swap_file" bs=1M count="$swap_mb" conv=fsync status=none',
    '  sudo -n chmod 600 "$swap_file"',
    '  sudo -n mkswap "$swap_file" >/dev/null',
    "fi",
    "if ! swap_is_active; then",
    '  if ! sudo -n swapon "$swap_file"; then',
    "    if ! swap_is_active; then",
    '      echo "swapon failed and expected swap is not active: $swap_file" >&2',
    "      exit 1",
    "    fi",
    "  fi",
    "fi",
    "swap_is_active",
  ].join("\n");
}

/** Create or reactivate the configured disk-backed swap. This runs after any
 * checkpoint restore and again before resumed services, because swap activation
 * is kernel state and does not survive a VM reboot even though the file does. */
export async function configureSpriteSwap(
  client: SpritesClient,
  spriteName: string,
  swapMb: number,
): Promise<void> {
  if (swapMb <= 0) return;
  const result = await client.exec(spriteName, { cmd: spriteSwapSetupCommand(swapMb), timeoutMs: 10 * 60_000 });
  if (result.exitCode !== 0) {
    throw new SpritesBootstrapError(
      "configure-swap",
      `configure-swap failed with exit ${result.exitCode}: ${tailKb(result.stderr || result.stdout || "")}`,
    );
  }
}

export interface BootstrapOptions {
  /** Bundle identity (sha1 of the shipped bundle); keys the checkpoint. */
  workerSha: string;
  bundleUrl: string;
  /** Operator-provided executable already present in the Sprite. */
  codexBinary?: string;
  /** Exact runtime for a warm baseline; cold Sprites default to Node 22. */
  nodeVersion?: string;
  /** Leave sealing to a baseline manager when false. */
  checkpoint?: boolean;
  onStep?: (name: string, status: "running" | "success" | "error", durationMs: number) => void;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// `{sha}` is optional: the default control-plane route needs none.
function expandBundleUrl(template: string, sha: string): string {
  return template.replaceAll("{sha}", sha);
}

function tailKb(s: string, kb = 2): string {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= kb * 1024) return s;
  // Slice last 2KB by bytes, not chars, to avoid breaking multi-byte.
  return Buffer.from(s, "utf8").subarray(bytes - kb * 1024).toString("utf8");
}

export async function bootstrapSprite(
  client: SpritesClient,
  spriteName: string,
  opts: BootstrapOptions,
): Promise<void> {
  const { workerSha, bundleUrl: bundleUrlTemplate, onStep } = opts;
  const codexBinary = opts.codexBinary || SPRITE_CODEX_BINARY;
  const installCodex = !opts.codexBinary;
  const bundleUrl = expandBundleUrl(bundleUrlTemplate, workerSha);
  const nodeVersion = opts.nodeVersion ?? SPRITE_NODE_VERSION;
  const nodeSetupCommand = spriteNodeSetupCommand(nodeVersion);
  const expectedComment = spriteBootstrapComment(workerSha, nodeVersion);

  // Idempotency: if a checkpoint for this SHA already exists, skip bootstrap.
  // This covers the 409 "sprite already exists" path where a previous create()
  // bootstrapped and checkpointed before crashing before the DB row insert.
  try {
    const checkpoints = await client.listCheckpoints(spriteName);
    if (checkpoints.some((cp) => cp.comment === expectedComment)) {
      onStep?.("fetch-worker", "success", 0);
      onStep?.("install-node", "success", 0);
      if (installCodex) onStep?.("install-codex", "success", 0);
      onStep?.("verify-worker", "success", 0);
      onStep?.("checkpoint", "success", 0);
      return;
    }
  } catch {
    // listCheckpoints failure is not fatal; proceed with bootstrap and let
    // the step errors surface if the sprite is truly not ready.
  }

  // Step 1: fetch-worker
  {
    const start = Date.now();
    onStep?.("fetch-worker", "running", 0);
    const cmd = `mkdir -p /home/user/worker && curl -fsSL ${shellQuote(bundleUrl)} | tar -xz -C /home/user/worker`;
    const result = await client.exec(spriteName, { cmd });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("fetch-worker", "error", durationMs);
      const stderrTail = tailKb(result.stderr || result.stdout || "");
      throw new SpritesBootstrapError("fetch-worker", `fetch-worker failed with exit ${result.exitCode}: ${stderrTail}`);
    }
    onStep?.("fetch-worker", "success", durationMs);
  }

  // Select the runtime before any npm invocation or service is started.
  {
    const start = Date.now();
    onStep?.("install-node", "running", 0);
    const result = await client.exec(spriteName, { cmd: nodeSetupCommand, timeoutMs: 10 * 60_000 });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("install-node", "error", durationMs);
      throw new SpritesBootstrapError("install-node", `install-node failed with exit ${result.exitCode}: ${tailKb(result.stderr || result.stdout || "")}`);
    }
    onStep?.("install-node", "success", durationMs);
  }

  // install-codex. A custom binary is useful for operators running a
  // pre-provisioned image and must not be overwritten by bootstrap.
  if (installCodex) {
    const start = Date.now();
    onStep?.("install-codex", "running", 0);
    // Installing @openai/codex pulls the platform-specific optional package
    // for the Sprite's architecture. Resolve its target triple at runtime,
    // then expose a stable path to the worker so it never relies on the
    // SDK's package-resolution search inside the one-file bundle.
    const cmd = [
      "set -eu",
      `mkdir -p ${SPRITE_CODEX_ROOT}/bin`,
      `npm install --prefix ${shellQuote(SPRITE_CODEX_ROOT)} --no-save --no-package-lock --ignore-scripts --include=optional --no-audit --no-fund @openai/codex@${SPRITE_CODEX_VERSION}`,
      `native=$(find ${SPRITE_CODEX_ROOT}/node_modules -type f -path '*/vendor/*/bin/codex' -perm -u+x -print -quit)`,
      'test -n "$native"',
      `ln -sfn "$native" ${shellQuote(codexBinary)}`,
    ].join(" && ");
    const result = await client.exec(spriteName, { cmd, timeoutMs: 10 * 60_000 });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("install-codex", "error", durationMs);
      const stderrTail = tailKb(result.stderr || result.stdout || "");
      throw new SpritesBootstrapError("install-codex", `install-codex failed with exit ${result.exitCode}: ${stderrTail}`);
    }
    onStep?.("install-codex", "success", durationMs);
  }

  // Step 3: verify-worker
  {
    const start = Date.now();
    onStep?.("verify-worker", "running", 0);
    const result = await client.exec(spriteName, {
      cmd: `test -f /home/user/worker/dist/run-worker.js && test -f /home/user/worker/codeact/thread-worker.js && test -f ${shellQuote(SPRITE_CODEACT_WASM)} && (cd ${shellQuote(SPRITE_CODEACT_WASM.slice(0, SPRITE_CODEACT_WASM.lastIndexOf("/")))} && sha256sum -c ${shellQuote(SPRITE_CODEACT_WASM.split("/").at(-1)! + ".sha256")}) && TASK_ORCH_QUICKJS_WASM=${shellQuote(SPRITE_CODEACT_WASM)} TASK_ORCH_CODEACT_THREAD_WORKER=/home/user/worker/codeact/thread-worker.js node /home/user/worker/dist/run-worker.js --smoke-codeact && test -x ${shellQuote(codexBinary)} && ${shellQuote(codexBinary)} --version >/dev/null`,
    });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("verify-worker", "error", durationMs);
      const stderrTail = tailKb(result.stderr || result.stdout || "");
      throw new SpritesBootstrapError("verify-worker", `verify-worker failed with exit ${result.exitCode}: ${stderrTail}`);
    }
    onStep?.("verify-worker", "success", durationMs);
  }

  if (opts.checkpoint === false) return;
  // Step 4: checkpoint
  {
    const start = Date.now();
    onStep?.("checkpoint", "running", 0);
    try {
      await client.checkpoint(spriteName, expectedComment);
      const durationMs = Date.now() - start;
      onStep?.("checkpoint", "success", durationMs);
    } catch (err) {
      const durationMs = Date.now() - start;
      onStep?.("checkpoint", "error", durationMs);
      const msg = err instanceof Error ? err.message : String(err);
      throw new SpritesBootstrapError("checkpoint", `checkpoint failed: ${msg}`);
    }
  }
}
