import { describe, expect, it } from "vitest";
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
