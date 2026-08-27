// lib/prewarm.ts
//
// Runtime side of the baked-dependency prewarm (see scripts/build-prewarm.sh and
// worker image). The image ships a fully-installed checkout of the
// primary target repo at $PREWARM_DIR (node_modules for root + every workspace,
// packages built, Playwright browsers under $PLAYWRIGHT_BROWSERS_PATH). After a
// run clones its repo onto the session volume, applyPrewarmToCheckout symlinks
// that baked node_modules tree into the fresh checkout — so the agent starts
// with deps ready instead of paying a multi-minute `npm ci` + browser download.
//
// Safety: the link is applied ONLY when the checkout's git origin resolves to
// the same owner/repo the prewarm was built for (recorded in
// $PREWARM_DIR/.prewarm-repo). A checkout of any other repo is left untouched,
// so nodetool's node_modules can never bleed into a different project. Agents
// that need to change dependencies run `npm run isolate-env` exactly as before
// (it replaces the symlinks with a private install).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ownerRepoFromRemote } from "./gh-url";
import { linkNodeModulesTree } from "./worktree-env";

const execFileP = promisify(execFile);

/** Normalize a remote URL OR a plain "owner/repo" to lowercase "owner/repo". */
function toOwnerRepo(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const fromRemote = ownerRepoFromRemote(s);
  if (fromRemote) return `${fromRemote.owner}/${fromRemote.repo}`.toLowerCase();
  // Plain "owner/repo" (the marker file's format).
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The baked prewarm directory, or null when the image shipped without one. */
export function prewarmDir(): string | null {
  const dir = process.env.PREWARM_DIR;
  if (!dir || !existsSync(dir)) return null;
  return dir;
}

/** owner/repo the prewarm was built for, or null if unmarked/absent. */
async function prewarmRepo(dir: string): Promise<string | null> {
  const raw = await readFile(join(dir, ".prewarm-repo"), "utf8").catch(() => null);
  return raw ? toOwnerRepo(raw) : null;
}

/** origin remote of a checkout, normalized to owner/repo, or null. */
async function checkoutOriginRepo(checkoutDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["remote", "get-url", "origin"], { cwd: checkoutDir });
    return toOwnerRepo(stdout);
  } catch {
    return null;
  }
}

/**
 * Symlink the baked node_modules tree into `checkoutDir` when it is a checkout of
 * the prewarmed repo. No-op (returns false) when there is no prewarm, the marker
 * is missing, or the checkout is a different repo. Best-effort: never throws —
 * a failure just means the run pays its own install, which still works.
 *
 * Returns true iff the prewarm was applied (deps linked).
 */
export async function applyPrewarmToCheckout(checkoutDir: string): Promise<boolean> {
  try {
    const dir = prewarmDir();
    if (!dir) return false;
    const want = await prewarmRepo(dir);
    if (!want) return false;
    const have = await checkoutOriginRepo(checkoutDir);
    if (!have || have !== want) return false;
    const linked = await linkNodeModulesTree(dir, checkoutDir);
    if (linked.length > 0) {
      console.log(
        `[prewarm] linked ${linked.length} baked node_modules dir(s) for ${want} into ${checkoutDir}`
      );
    }
    return linked.length > 0;
  } catch (err) {
    console.warn(`[prewarm] applyPrewarmToCheckout failed for ${checkoutDir}: ${describe(err)}`);
    return false;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
