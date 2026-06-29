import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkSharedWorktreeArtifacts } from "../lib/runs";

// Each worktree shares the repo root's node_modules and Turbopack/.next build
// cache via symlink, so a fresh worktree skips the (slow) install + cold build.
describe("linkSharedWorktreeArtifacts", () => {
  let root: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shared-root-"));
    worktree = join(root, ".worktrees", "1");
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    // tmp dirs are reclaimed by the OS; nothing critical to clean.
  });

  it("symlinks node_modules to the root store when the root has one", async () => {
    mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 0;");

    await linkSharedWorktreeArtifacts(worktree, root);

    const link = join(worktree, "node_modules");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(await realpath(join(root, "node_modules")));
    // Resolution through the link reaches the shared dependency.
    expect(readFileSync(join(link, "left-pad", "index.js"), "utf8")).toContain("module.exports");
  });

  it("does NOT link node_modules when the root has none (no dangling link)", async () => {
    await linkSharedWorktreeArtifacts(worktree, root);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("creates the .next cache target and links to it so the first build can write through", async () => {
    await linkSharedWorktreeArtifacts(worktree, root);

    const link = join(worktree, ".next");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, ".next"))).toBe(true);
    expect(await realpath(link)).toBe(await realpath(join(root, ".next")));
  });

  it("leaves an existing real node_modules in the worktree untouched", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    // Worktree already has its own real node_modules — don't clobber it.
    mkdirSync(join(worktree, "node_modules", "own-dep"), { recursive: true });

    await linkSharedWorktreeArtifacts(worktree, root);

    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(false);
    expect(existsSync(join(worktree, "node_modules", "own-dep"))).toBe(true);
  });

  it("is a no-op when the worktree path equals the root (no self-link)", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    await linkSharedWorktreeArtifacts(root, root);
    expect((await lstat(join(root, "node_modules"))).isSymbolicLink()).toBe(false);
  });

  it("points node_modules and .next at distinct shared targets", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    await linkSharedWorktreeArtifacts(worktree, root);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
    expect(await readlink(join(worktree, ".next"))).toBe(join(root, ".next"));
  });
});
