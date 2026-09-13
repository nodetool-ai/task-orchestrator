// __tests__/worker-standalone-bundle.test.ts
//
// Regression guard for the standalone worker bundle (spec §2): built, copied
// ALONE into an empty directory (no node_modules, no repo), it must reach its
// own argument check — exit 2 with the usage message. Any future import that
// reintroduces a node_modules or native dependency fails here, at build time,
// instead of inside a Box template at run time.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone worker bundle", () => {
  it("builds and executes CodeAct from only the shipped artifacts", () => {
    execFileSync("npm", ["run", "build:worker:standalone"], { stdio: "pipe", timeout: 120_000 });
    expect(existsSync("dist/codeact/emscripten-module.wasm")).toBe(true);
    expect(existsSync("dist/codeact/emscripten-module.wasm.sha256")).toBe(true);
    expect(existsSync("dist/codeact/thread-worker.js")).toBe(true);
    expect(existsSync("dist/process-supervisor.py")).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "worker-bundle-iso-"));
    try {
      copyFileSync("dist/run-worker.standalone.js", join(dir, "run-worker.js"));
      const codeactDir = join(dir, "codeact");
      mkdirSync(codeactDir);
      copyFileSync("dist/codeact/emscripten-module.wasm", join(codeactDir, "emscripten-module.wasm"));
      copyFileSync("dist/codeact/emscripten-module.wasm.sha256", join(codeactDir, "emscripten-module.wasm.sha256"));
      copyFileSync("dist/codeact/thread-worker.js", join(codeactDir, "thread-worker.js"));
      const res = spawnSync(process.execPath, ["run-worker.js", "--smoke-codeact"], {
        cwd: dir,
        env: { ...process.env, TASK_ORCH_QUICKJS_WASM: join(codeactDir, "emscripten-module.wasm"), TASK_ORCH_CODEACT_THREAD_WORKER: join(codeactDir, "thread-worker.js") },
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("CodeAct smoke: 42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
