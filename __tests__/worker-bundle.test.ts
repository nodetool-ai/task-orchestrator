import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { tarSingleFile } from "../lib/worker-bundle";

describe("worker bundle tar", () => {
  it("produces an archive the system tar extracts to the expected path", () => {
    const content = Buffer.from("console.log('worker');\n".repeat(50));
    const tgz = gzipSync(tarSingleFile("dist/run-worker.js", content));
    const dir = mkdtempSync(join(tmpdir(), "wb-"));
    writeFileSync(join(dir, "b.tgz"), tgz);
    execFileSync("tar", ["-xzf", "b.tgz"], { cwd: dir });
    expect(readFileSync(join(dir, "dist", "run-worker.js"))).toEqual(content);
    expect(execFileSync("tar", ["-tzf", "b.tgz"], { cwd: dir }).toString().trim()).toBe("dist/run-worker.js");
  });
});

describe("sprites bundle url default", () => {
  it("derives from TASK_ORCH_PUBLIC_URL when no explicit url is set", async () => {
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "");
    vi.stubEnv("TASK_ORCH_PUBLIC_URL", "https://cp.example.com/");
    const { config } = await import("../lib/config");
    expect(config.sprites.workerBundleUrl).toBe("https://cp.example.com/api/worker-bundle");
    vi.stubEnv("TASK_ORCH_SPRITES_WORKER_BUNDLE_URL", "https://cdn.example.com/w-{sha}.tgz");
    expect(config.sprites.workerBundleUrl).toBe("https://cdn.example.com/w-{sha}.tgz");
    vi.unstubAllEnvs();
  });
});
