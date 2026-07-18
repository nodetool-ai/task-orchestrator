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
