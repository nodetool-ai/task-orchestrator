// Shared vs. isolated worktree environments.
//
// By default every worktree symlinks `node_modules` and the Turbopack/Next.js
// build cache (`.next`) back to the repo root, so concurrent worktrees share a
// single install and a warm build cache. linkSharedWorktreeArtifacts is called
// right after `git worktree add` (see lib/runs.ts).
//
// A worktree that needs to change dependencies — or just wants a clean, private
// build cache — opts out with unlinkSharedWorktreeArtifacts followed by a fresh
// `npm install`. The `npm run isolate-env` script does exactly that from inside
// a worktree (scripts/isolate-worktree-env.ts).
//
// This module is deliberately dependency-free (only node:fs / node:path) so the
// CLI script can use it without dragging in the agent runner and SDK.

import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface SharedArtifact {
  /** Path component shared from the repo root into each worktree. */
  name: string;
  // When the root has no such entry: 'create' makes an empty dir (a writable
  // cache the first build fills); 'skip' leaves the worktree unlinked — a
  // dangling link would be worse than a missing dir (e.g. node_modules before
  // the first install: a broken link makes module resolution fail outright).
  whenMissingAtRoot: "create" | "skip";
}

// `.next` is a single top-level cache. `node_modules` is handled separately by
// the node_modules-tree linker below (a monorepo has one at the root AND one per
// workspace, e.g. web/node_modules, packages/*/node_modules), so it is NOT in
// this list — linkSharedWorktreeArtifacts links the whole tree, not just the root.
export const SHARED_WORKTREE_ARTIFACTS: SharedArtifact[] = [
  { name: ".next", whenMissingAtRoot: "create" },
];

// How deep to walk when discovering node_modules dirs. Covers root (0),
// web/electron (1), packages/<pkg> (2), and one level of nesting beyond — deep
// enough for the workspace layouts we bake, shallow enough to stay cheap.
const NODE_MODULES_SCAN_MAX_DEPTH = 4;
// Directories never worth descending into while discovering node_modules dirs.
const SCAN_PRUNE_DIRS = new Set([".git", ".worktrees", ".next", ".turbo", "dist"]);

/**
 * Discover every `node_modules` directory under `baseDir`, returned as paths
 * relative to `baseDir` (e.g. "node_modules", "web/node_modules",
 * "packages/websocket/node_modules"). Prunes at each `node_modules` (records it,
 * never descends into its contents) and skips build/vcs dirs, so this is cheap
 * even when the trees themselves are multi-GB. Order is stable (sorted).
 */
export async function discoverNodeModulesDirs(baseDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → nothing to discover here
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name === "node_modules") {
        found.push(rel ? join(rel, "node_modules") : "node_modules");
        continue; // never descend into a node_modules
      }
      if (depth >= NODE_MODULES_SCAN_MAX_DEPTH) continue;
      if (e.name.startsWith(".") || SCAN_PRUNE_DIRS.has(e.name)) continue;
      if (!e.isDirectory()) continue; // don't follow non-node_modules symlinks
      await walk(join(dir, e.name), rel ? join(rel, e.name) : e.name, depth + 1);
    }
  }
  await walk(baseDir, "", 0);
  return found.sort();
}

/**
 * Symlink every `node_modules` directory from `fromDir` into `toDir` at the same
 * relative path, idempotently and with the same repair/never-clobber semantics
 * as the shared-artifact linker. Used two ways:
 *   • prewarm (image) → per-run checkout root: baked deps become present.
 *   • checkout root → worktree: worktrees inherit the whole install, not just the
 *     top-level node_modules (a monorepo needs web/, packages/* linked too).
 * A worktree that ran `isolate-env` (real private node_modules) is never
 * clobbered. Best-effort per dir: a failure is logged, not thrown. Returns the
 * relative paths actually linked (or already correct).
 */
export async function linkNodeModulesTree(fromDir: string, toDir: string): Promise<string[]> {
  if (resolve(fromDir) === resolve(toDir)) return [];
  const dirs = await discoverNodeModulesDirs(fromDir);
  const linked: string[] = [];
  await Promise.all(
    dirs.map(async (rel) => {
      const target = join(fromDir, rel);
      const linkPath = join(toDir, rel);
      try {
        const existing = await lstat(linkPath).catch(() => null);
        if (existing) {
          if (!existing.isSymbolicLink()) return; // real private dir — never clobber
          if (await linkPointsAt(linkPath, target)) {
            linked.push(rel);
            return;
          }
          await rm(linkPath, { force: true }); // stale/wrong/dangling → replace
        }
        await mkdir(dirname(linkPath), { recursive: true });
        await symlinkSharedTarget(target, linkPath);
        linked.push(rel);
      } catch (err) {
        console.warn(`[worktree-env] failed to link node_modules ${rel} into ${toDir}: ${describe(err)}`);
      }
    })
  );
  return linked.sort();
}

/**
 * Link each shared artifact from the repo root into a worktree, idempotently.
 *
 * Robust against re-runs and partial/stale state:
 * - A correct existing link is left as-is (safe to call repeatedly).
 * - A real dir/file the worktree already owns is never clobbered (this is how a
 *   worktree isolated via `npm run isolate-env` keeps its private install).
 * - A stale, wrong, or dangling symlink (e.g. the root store was wiped and
 *   reinstalled) is repaired — removed and re-pointed at the current target.
 * - Concurrent materialization of the same worktree is tolerated: an EEXIST
 *   race is accepted iff the link ended up pointing where we wanted.
 *
 * Best-effort per artifact: a failure is logged, not thrown, and never blocks
 * the other artifact. The worktree still works unlinked — just colder (its own
 * install / cache). Callers run this right after `git worktree add`.
 */
export async function linkSharedWorktreeArtifacts(
  worktreePath: string,
  root: string
): Promise<void> {
  // Don't symlink a worktree into its own root's store (e.g. degenerate setups
  // where the worktree path resolves to the repo root) — that would create a
  // self-referential link.
  if (resolve(worktreePath) === resolve(root)) return;
  await Promise.all([
    // The full node_modules tree (root + every nested workspace dir), so a
    // worktree of a monorepo can resolve deps at every level, not just the root.
    linkNodeModulesTree(root, worktreePath).then(() => undefined),
    ...SHARED_WORKTREE_ARTIFACTS.map((artifact) =>
      linkOneSharedArtifact(artifact, worktreePath, root).catch((err) => {
        console.warn(
          `[worktree-env] failed to link shared ${artifact.name} into ${worktreePath}: ${describe(err)}`
        );
      })
    ),
  ]);
}

/**
 * Break a worktree out of the shared store: remove any shared artifact that is
 * currently a symlink (into the root). Real, private dirs are left untouched, so
 * this is safe to call on an already-isolated worktree. Returns the names that
 * were actually unlinked (sorted, for determinism).
 *
 * After unlinking, callers must run a fresh `npm install` so `node_modules` is
 * repopulated privately — an unlinked worktree has no dependency tree until then.
 */
export async function unlinkSharedWorktreeArtifacts(
  worktreePath: string
): Promise<string[]> {
  // node_modules is a whole tree of symlinks (root + nested workspaces); remove
  // every one that is currently a symlink so the caller's fresh `npm install`
  // repopulates a fully private tree. Real private dirs are left untouched.
  const nmDirs = await discoverNodeModulesDirs(worktreePath);
  const artifactNames = SHARED_WORKTREE_ARTIFACTS.map((a) => a.name);
  const unlinked = await Promise.all(
    [...nmDirs, ...artifactNames].map(async (name) => {
      const linkPath = join(worktreePath, name);
      const st = await lstat(linkPath).catch(() => null);
      if (!st?.isSymbolicLink()) return null; // absent or a real private dir
      await rm(linkPath, { force: true });
      return name;
    })
  );
  return unlinked.filter((n): n is string => n !== null).sort();
}

async function linkOneSharedArtifact(
  artifact: SharedArtifact,
  worktreePath: string,
  root: string
): Promise<void> {
  const target = join(root, artifact.name);
  const linkPath = join(worktreePath, artifact.name);

  // Ensure the shared target exists — or bail when we must not fabricate it.
  if (!existsSync(target)) {
    if (artifact.whenMissingAtRoot === "skip") return;
    await mkdir(target, { recursive: true });
  }

  // Inspect the destination WITHOUT following the link (lstat, not existsSync)
  // so we can see a dangling/stale symlink instead of treating it as absent.
  const existing = await lstat(linkPath).catch(() => null);
  if (existing) {
    if (!existing.isSymbolicLink()) return; // a real dir/file — never clobber
    if (await linkPointsAt(linkPath, target)) return; // already correct
    await rm(linkPath, { force: true }); // stale/wrong/dangling → replace
  }

  await symlinkSharedTarget(target, linkPath);
}

/** True when `linkPath` is a symlink resolving to `target`. */
async function linkPointsAt(linkPath: string, target: string): Promise<boolean> {
  const current = await readlink(linkPath).catch(() => null);
  if (current === null) return false;
  // Resolve relative links against the link's own directory before comparing.
  return resolve(dirname(linkPath), current) === resolve(target);
}

/** Create the link, tolerating a concurrent creator that beat us to the punch. */
async function symlinkSharedTarget(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, "dir");
  } catch (err) {
    // Another worktree materialization may have created the same link between
    // our check and our create. Accept it iff it points where we intended;
    // otherwise surface the error.
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST" && (await linkPointsAt(linkPath, target))) {
      return;
    }
    throw err;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

// ──────────────────────────────────────────────────────────
// Per-worktree dev-server ports
// ──────────────────────────────────────────────────────────
//
// Concurrent worktrees can't all bind the default port 3000. Each worktree gets
// a deterministic port in a private range so it's collision-free *and* stable
// across restarts (the same worktree always gets the same URL). The
// `npm run worktree-dev` script binds this port to loopback only.

export const DEV_PORT_BASE = 3100;
// 3100–3999: 900 slots, comfortably clear of 3000 (prod/default) and the
// ephemeral range. Enough headroom that collisions need either >900 live
// worktrees or a hash clash, both handled by the script's free-port probe.
export const DEV_PORT_SPAN = 900;

/**
 * Deterministic preferred dev-server port for a worktree. Worktree dirs are
 * named `.worktrees/<runId>` (or `review-<id>` / `chat-<id>`), so the trailing
 * number drives the port for a predictable mapping; a non-numeric basename
 * falls back to a stable hash. Always lands in [DEV_PORT_BASE, +DEV_PORT_SPAN).
 *
 * Deterministic only — it does not check whether the port is free. The
 * worktree-dev script probes upward from here for an open port at launch.
 */
export function preferredDevPort(worktreePath: string): number {
  const name = basename(resolve(worktreePath));
  const trailing = name.match(/(\d+)$/);
  const seed = trailing ? parseInt(trailing[1], 10) : hashString(name);
  return DEV_PORT_BASE + (seed % DEV_PORT_SPAN);
}

/** Stable 32-bit FNV-1a hash → non-negative int. Used for non-numeric names. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}
