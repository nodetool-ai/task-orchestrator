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
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
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

export const SHARED_WORKTREE_ARTIFACTS: SharedArtifact[] = [
  { name: "node_modules", whenMissingAtRoot: "skip" },
  { name: ".next", whenMissingAtRoot: "create" },
];

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
  await Promise.all(
    SHARED_WORKTREE_ARTIFACTS.map((artifact) =>
      linkOneSharedArtifact(artifact, worktreePath, root).catch((err) => {
        console.warn(
          `[worktree-env] failed to link shared ${artifact.name} into ${worktreePath}: ${describe(err)}`
        );
      })
    )
  );
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
  const unlinked = await Promise.all(
    SHARED_WORKTREE_ARTIFACTS.map(async ({ name }) => {
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
