import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPrewarmToCheckout } from "../lib/prewarm";

// The prewarm image bakes a full node_modules tree for ONE repo. applyPrewarm
// links it into a per-run checkout ONLY when that checkout's git origin matches
// the baked repo — so nodetool's deps can never bleed into a different project.
describe("applyPrewarmToCheckout", () => {
  let prewarm: string;
  let checkout: string;

  function gitCheckout(originUrl: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pw-checkout-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
    return dir;
  }

  beforeEach(() => {
    prewarm = mkdtempSync(join(tmpdir(), "pw-src-"));
    for (const rel of ["node_modules/left-pad", "web/node_modules/react"]) {
      mkdirSync(join(prewarm, rel), { recursive: true });
      writeFileSync(join(prewarm, rel, "index.js"), "module.exports = 1;");
    }
    writeFileSync(join(prewarm, ".prewarm-repo"), "nodetool-ai/nodetool\n");
    process.env.PREWARM_DIR = prewarm;
  });

  afterEach(() => {
    delete process.env.PREWARM_DIR;
    vi.restoreAllMocks();
  });

  it("links the baked tree when the checkout origin matches the prewarmed repo", async () => {
    checkout = gitCheckout("https://github.com/nodetool-ai/nodetool.git");
    const applied = await applyPrewarmToCheckout(checkout);
    expect(applied).toBe(true);
    expect((await lstat(join(checkout, "node_modules"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(checkout, "web/node_modules"))).isSymbolicLink()).toBe(true);
  });

  it("matches regardless of remote URL form (ssh / no .git / case)", async () => {
    checkout = gitCheckout("git@github.com:NodeTool-AI/NodeTool.git");
    expect(await applyPrewarmToCheckout(checkout)).toBe(true);
  });

  it("does NOT link into a checkout of a different repo", async () => {
    checkout = gitCheckout("https://github.com/someone/other-project.git");
    const applied = await applyPrewarmToCheckout(checkout);
    expect(applied).toBe(false);
    expect(existsSync(join(checkout, "node_modules"))).toBe(false);
  });

  it("no-ops when no prewarm image is present", async () => {
    delete process.env.PREWARM_DIR;
    checkout = gitCheckout("https://github.com/nodetool-ai/nodetool.git");
    expect(await applyPrewarmToCheckout(checkout)).toBe(false);
  });

  it("no-ops (never throws) when the marker is missing", async () => {
    execFileSync("rm", [join(prewarm, ".prewarm-repo")]);
    checkout = gitCheckout("https://github.com/nodetool-ai/nodetool.git");
    expect(await applyPrewarmToCheckout(checkout)).toBe(false);
  });
});
