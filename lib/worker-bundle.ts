// lib/worker-bundle.ts
//
// Locates the standalone worker bundle the control plane serves to blank-
// provisioned Box runners (spec: 2026-07-18-box-blank-provision-design.md §1).
// The sha256 is what the box verifies after download, so it is computed from
// the exact bytes on disk and cached only while (mtime, size) are unchanged.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BUNDLE_PATH = join(process.cwd(), "dist", "run-worker.standalone.js");
const SHA_RE = /^[a-f0-9]{40}$/;

let cache: { path: string; mtimeMs: number; size: number; sha256: string } | null = null;

export function locateWorkerBundle(
  opts: { path?: string } = {}
): { path: string; size: number; sha256: string } | null {
  const path = opts.path ?? DEFAULT_BUNDLE_PATH;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (cache && cache.path === path && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return { path, size: cache.size, sha256: cache.sha256 };
  }
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  cache = { path, mtimeMs: stat.mtimeMs, size: stat.size, sha256 };
  return { path, size: stat.size, sha256 };
}

/**
 * Read the bundle's bytes ONCE and derive size + sha256 from that same
 * buffer, so a route serving {bytes, size, sha256} together can never mismatch
 * because of a mid-deploy rewrite between two separate reads. No caching here
 * (unlike locateWorkerBundle): this is a per-run-frequency route, not a hot path.
 */
export function readWorkerBundle(
  opts: { path?: string } = {}
): { bytes: Buffer; size: number; sha256: string } | null {
  const path = opts.path ?? DEFAULT_BUNDLE_PATH;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, size: bytes.length, sha256 };
}

/** Derive the sibling `.sha` path for a bundle path (mirrors locateWorkerBundle's
 *  path resolution: explicit opts.path, else the default bundle location). */
function bundleShaPath(opts: { path?: string } = {}): string {
  return `${opts.path ?? DEFAULT_BUNDLE_PATH}.sha`;
}

/**
 * The git SHA baked next to the bundle at build time (scripts/build-worker-
 * standalone.mjs writes it as dist/run-worker.standalone.js.sha). This
 * identifies exactly what bytes the bundle contains, unlike workerBuildSha()
 * (a remote ref tip / env override) which can drift from what was actually
 * built into this deployment's image. Returns null when the sidecar file is
 * missing or does not hold a well-formed 40-hex sha.
 */
export function bundleWorkerSha(opts: { path?: string } = {}): string | null {
  let content: string;
  try {
    content = readFileSync(bundleShaPath(opts), "utf8");
  } catch {
    return null;
  }
  const sha = content.trim();
  return SHA_RE.test(sha) ? sha : null;
}
