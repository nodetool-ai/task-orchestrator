// __tests__/worker-standalone-bundle.test.ts
//
// Regression guard for the standalone worker bundle (spec §2): built, copied
// ALONE into an empty directory (no node_modules, no repo), it must reach its
// own argument check — exit 2 with the usage message. Any future import that
// reintroduces a node_modules or native dependency fails here, at build time,
// instead of inside a Box template at run time.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone worker bundle", () => {
  it("builds, and runs alone in an empty directory to exit 2 (usage)", () => {
    execFileSync("npm", ["run", "build:worker:standalone"], { stdio: "pipe", timeout: 120_000 });

    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-iso-"));
    try {
      copyFileSync("dist/run-worker.standalone.js", join(dir, "run-worker.js"));
      const res = spawnSync(process.execPath, ["run-worker.js"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(res.status).toBe(2);
      expect(`${res.stdout}${res.stderr}`).toMatch(/usage: run-worker/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
