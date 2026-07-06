import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEV_PORT_BASE,
  DEV_PORT_SPAN,
  discoverNodeModulesDirs,
  linkNodeModulesTree,
  linkSharedWorktreeArtifacts,
  preferredDevPort,
  unlinkSharedWorktreeArtifacts,
} from "../lib/worktree-env";

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

  it("is idempotent — a second call leaves a correct link untouched", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    await linkSharedWorktreeArtifacts(worktree, root);
    // A second run must not throw (no EEXIST) and must keep the same link.
    await linkSharedWorktreeArtifacts(worktree, root);
    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
  });

  it("repairs a dangling node_modules symlink (existsSync would miss it)", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    // Pre-existing link to a target that no longer exists.
    symlinkSync(join(root, "gone-modules"), join(worktree, "node_modules"));
    expect(existsSync(join(worktree, "node_modules"))).toBe(false); // dangling

    await linkSharedWorktreeArtifacts(worktree, root);

    expect(await readlink(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
    expect(existsSync(join(worktree, "node_modules"))).toBe(true);
  });

  it("repairs a symlink pointing at the wrong target", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const stale = mkdtempSync(join(tmpdir(), "stale-store-"));
    symlinkSync(stale, join(worktree, "node_modules"));

    await linkSharedWorktreeArtifacts(worktree, root);

    expect(await readlink(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
  });

  it("links both artifacts even if one would fail (best-effort, independent)", async () => {
    // node_modules present so it links; .next target is occupied by a *file* at
    // the worktree, so it's a real entry we must not clobber. The node_modules
    // link must still be created regardless.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(worktree, ".next"), "i am a real file, leave me alone");

    await linkSharedWorktreeArtifacts(worktree, root);

    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(true);
    // The real .next file is untouched (not a symlink, content preserved).
    expect((await lstat(join(worktree, ".next"))).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(worktree, ".next"), "utf8")).toContain("leave me alone");
  });

  it("tolerates concurrent calls without throwing (EEXIST race)", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    // Fire several materializations of the same worktree at once.
    await Promise.all(
      Array.from({ length: 5 }, () => linkSharedWorktreeArtifacts(worktree, root))
    );
    expect(await readlink(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
    expect((await lstat(join(worktree, ".next"))).isSymbolicLink()).toBe(true);
  });
});

// `npm run isolate-env` uses this to break a worktree out of the shared store
// before installing private dependencies.
describe("unlinkSharedWorktreeArtifacts", () => {
  let root: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "isolate-root-"));
    worktree = join(root, ".worktrees", "1");
    mkdirSync(worktree, { recursive: true });
  });

  it("removes the shared symlinks and reports which it removed", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    await linkSharedWorktreeArtifacts(worktree, root);
    // Both are symlinks at this point.
    expect((await lstat(join(worktree, "node_modules"))).isSymbolicLink()).toBe(true);

    const removed = await unlinkSharedWorktreeArtifacts(worktree);

    expect(removed).toEqual([".next", "node_modules"]); // sorted
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(existsSync(join(worktree, ".next"))).toBe(false);
    // The shared root store is NOT touched — only the worktree's links.
    expect(existsSync(join(root, "node_modules"))).toBe(true);
    expect(existsSync(join(root, ".next"))).toBe(true);
  });

  it("leaves a real private dir untouched (already isolated)", async () => {
    mkdirSync(join(worktree, "node_modules", "own-dep"), { recursive: true });

    const removed = await unlinkSharedWorktreeArtifacts(worktree);

    expect(removed).not.toContain("node_modules");
    expect(existsSync(join(worktree, "node_modules", "own-dep"))).toBe(true);
  });

  it("is a no-op when nothing is present", async () => {
    expect(await unlinkSharedWorktreeArtifacts(worktree)).toEqual([]);
  });

  it("only unlinks the symlinked artifact in a mixed worktree", async () => {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    await linkSharedWorktreeArtifacts(worktree, root); // links both
    // Replace the .next link with a real private dir.
    await unlinkSharedWorktreeArtifacts(worktree); // clear both first
    await linkSharedWorktreeArtifacts(worktree, root); // re-link node_modules + .next
    // Now make .next private: unlink then mkdir a real dir.
    const { rmSync } = await import("node:fs");
    rmSync(join(worktree, ".next"), { force: true });
    mkdirSync(join(worktree, ".next"), { recursive: true });

    const removed = await unlinkSharedWorktreeArtifacts(worktree);

    expect(removed).toEqual(["node_modules"]);
    expect((await lstat(join(worktree, ".next"))).isSymbolicLink()).toBe(false);
  });
});

// `npm run worktree-dev` binds this port to loopback so concurrent worktrees
// don't collide on 3000.
describe("preferredDevPort", () => {
  it("always lands inside the private dev-port range", () => {
    for (const p of [
      "/repo/.worktrees/1",
      "/repo/.worktrees/999",
      "/repo/.worktrees/review-42",
      "/repo/.worktrees/chat-7",
      "/some/oddly-named-worktree",
    ]) {
      const port = preferredDevPort(p);
      expect(port).toBeGreaterThanOrEqual(DEV_PORT_BASE);
      expect(port).toBeLessThan(DEV_PORT_BASE + DEV_PORT_SPAN);
    }
  });

  it("is deterministic — same worktree path → same port", () => {
    expect(preferredDevPort("/repo/.worktrees/12")).toBe(
      preferredDevPort("/repo/.worktrees/12")
    );
  });

  it("derives the port from the trailing run id", () => {
    // `.worktrees/<id>` → BASE + (id % SPAN), a predictable mapping.
    expect(preferredDevPort("/repo/.worktrees/5")).toBe(DEV_PORT_BASE + 5);
    expect(preferredDevPort("/repo/.worktrees/review-5")).toBe(DEV_PORT_BASE + 5);
  });

  it("gives different ports to different worktrees (no trivial collision)", () => {
    const ports = new Set(
      [1, 2, 3, 4, 5].map((id) => preferredDevPort(`/repo/.worktrees/${id}`))
    );
    expect(ports.size).toBe(5);
  });
});

// A monorepo has node_modules at the root AND per workspace (web/node_modules,
// packages/*/node_modules). The prewarm-baked install and the worktree linker
// must reproduce the WHOLE tree, not just the top-level dir. These cover
// discoverNodeModulesDirs + linkNodeModulesTree and the worktree integration.
describe("node_modules tree linking (monorepo)", () => {
  let src: string;
  let dst: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "nm-src-"));
    dst = mkdtempSync(join(tmpdir(), "nm-dst-"));
    // A miniature monorepo layout with nested workspace installs.
    for (const rel of [
      "node_modules/left-pad",
      "web/node_modules/react",
      "packages/websocket/node_modules/ws",
      "packages/agents/node_modules/zod",
    ]) {
      mkdirSync(join(src, rel), { recursive: true });
      writeFileSync(join(src, rel, "index.js"), "module.exports = 1;");
    }
    // A build dir under a package must NOT be mistaken for / descended past a
    // node_modules, and a nested node_modules INSIDE node_modules is not surfaced.
    mkdirSync(join(src, "node_modules", "left-pad", "node_modules"), { recursive: true });
  });

  it("discovers every node_modules dir, pruning inside node_modules", async () => {
    const dirs = await discoverNodeModulesDirs(src);
    expect(dirs).toEqual([
      "node_modules",
      "packages/agents/node_modules",
      "packages/websocket/node_modules",
      "web/node_modules",
    ]);
    // The node_modules-inside-node_modules is pruned (not surfaced).
    expect(dirs).not.toContain("node_modules/left-pad/node_modules");
  });

  it("symlinks the whole tree into a target checkout, resolvable at every level", async () => {
    const linked = await linkNodeModulesTree(src, dst);
    expect(linked).toContain("node_modules");
    expect(linked).toContain("web/node_modules");
    expect(linked).toContain("packages/websocket/node_modules");

    for (const rel of ["node_modules", "web/node_modules", "packages/websocket/node_modules"]) {
      const link = join(dst, rel);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await realpath(link)).toBe(await realpath(join(src, rel)));
    }
    // Deps resolve through the links.
    expect(readFileSync(join(dst, "web/node_modules/react/index.js"), "utf8")).toContain("module.exports");
  });

  it("never clobbers a real private node_modules the target already owns (isolate-env)", async () => {
    // The target isolated its web install: a real dir, not a symlink.
    mkdirSync(join(dst, "web", "node_modules", "private-dep"), { recursive: true });
    await linkNodeModulesTree(src, dst);
    expect((await lstat(join(dst, "web/node_modules"))).isSymbolicLink()).toBe(false);
    expect(existsSync(join(dst, "web/node_modules/private-dep"))).toBe(true);
    // But the untouched levels still got linked.
    expect((await lstat(join(dst, "node_modules"))).isSymbolicLink()).toBe(true);
  });

  it("linkSharedWorktreeArtifacts propagates nested workspace node_modules into a worktree", async () => {
    // Root has a full monorepo install; a worktree of it must see web/ + packages/*.
    const wt = join(src, ".worktrees", "9");
    mkdirSync(wt, { recursive: true });
    await linkSharedWorktreeArtifacts(wt, src);
    for (const rel of ["node_modules", "web/node_modules", "packages/agents/node_modules"]) {
      expect((await lstat(join(wt, rel))).isSymbolicLink()).toBe(true);
    }
  });

  it("isolate-env unlink removes every node_modules symlink in the tree", async () => {
    const wt = join(src, ".worktrees", "9");
    mkdirSync(wt, { recursive: true });
    await linkSharedWorktreeArtifacts(wt, src);
    const removed = await unlinkSharedWorktreeArtifacts(wt);
    expect(removed).toContain("node_modules");
    expect(removed).toContain("web/node_modules");
    expect(existsSync(join(wt, "web/node_modules"))).toBe(false);
  });
});
