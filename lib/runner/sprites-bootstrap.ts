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

export class SpritesBootstrapError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = "SpritesBootstrapError";
  }
}

export interface BootstrapOptions {
  /** Bundle identity (sha1 of the shipped bundle); keys the checkpoint. */
  workerSha: string;
  bundleUrl: string;
  onStep?: (name: string, status: "running" | "success" | "error", durationMs: number) => void;
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
  const bundleUrl = expandBundleUrl(bundleUrlTemplate, workerSha);
  const expectedComment = `bootstrap ${workerSha}`;

  // Idempotency: if a checkpoint for this SHA already exists, skip bootstrap.
  // This covers the 409 "sprite already exists" path where a previous create()
  // bootstrapped and checkpointed before crashing before the DB row insert.
  try {
    const checkpoints = await client.listCheckpoints(spriteName);
    if (checkpoints.some((cp) => cp.comment === expectedComment)) {
      onStep?.("fetch-worker", "success", 0);
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
    const cmd = `mkdir -p /home/user/worker && curl -fsSL ${JSON.stringify(bundleUrl)} | tar -xz -C /home/user/worker`;
    const result = await client.exec(spriteName, { cmd });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("fetch-worker", "error", durationMs);
      const stderrTail = tailKb(result.stderr || result.stdout || "");
      throw new SpritesBootstrapError("fetch-worker", `fetch-worker failed with exit ${result.exitCode}: ${stderrTail}`);
    }
    onStep?.("fetch-worker", "success", durationMs);
  }

  // Step 2: verify-worker
  {
    const start = Date.now();
    onStep?.("verify-worker", "running", 0);
    const result = await client.exec(spriteName, { cmd: "test -f /home/user/worker/dist/run-worker.js" });
    const durationMs = Date.now() - start;
    if (result.exitCode !== 0) {
      onStep?.("verify-worker", "error", durationMs);
      const stderrTail = tailKb(result.stderr || result.stdout || "");
      throw new SpritesBootstrapError("verify-worker", `verify-worker failed with exit ${result.exitCode}: ${stderrTail}`);
    }
    onStep?.("verify-worker", "success", durationMs);
  }

  // Step 3: checkpoint
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
