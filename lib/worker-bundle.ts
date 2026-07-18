// lib/worker-bundle.ts
//
// The standalone worker bundle the control plane UPLOADS into blank-
// provisioned Box runners (spec: 2026-07-18-box-blank-provision-design.md §1).
// The sha256 is what the box verifies after reassembling the uploaded parts,
// so it is computed from the exact bytes read off disk.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BUNDLE_PATH = join(process.cwd(), "dist", "run-worker.standalone.js");
const SHA_RE = /^[a-f0-9]{40}$/;

/**
 * Read the bundle's bytes ONCE and derive size + sha256 from that same
 * buffer, so the uploaded chunks and the verified sha can never mismatch
 * because of a mid-deploy rewrite between two separate reads. No caching:
 * provisioning is per-run frequency, not a hot path.
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

/** Derive the sibling `.sha` path for a bundle path (same resolution as
 *  readWorkerBundle: explicit opts.path, else the default bundle location). */
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
