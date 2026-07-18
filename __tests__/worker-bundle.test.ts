// __tests__/worker-bundle.test.ts
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleWorkerSha, readWorkerBundle } from "../lib/worker-bundle";
import { config } from "../lib/config";

const KNOBS = ["TASK_ORCH_BOX_PROVISION", "TASK_ORCH_BOX_PROVISION_TIMEOUT_S"];
let saved: Record<string, string | undefined>;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-bundle-"));
  saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  for (const k of KNOBS) delete process.env[k];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KNOBS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("readWorkerBundle", () => {
  it("returns null when the bundle file does not exist", () => {
    expect(readWorkerBundle({ path: join(dir, "nope.js") })).toBeNull();
  });

  it("returns bytes, size, and sha256 derived from one read", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "console.log('w')\n");
    const want = createHash("sha256").update("console.log('w')\n").digest("hex");
    const got = readWorkerBundle({ path: p });
    expect(got).toMatchObject({ size: 17, sha256: want });
    expect(got!.bytes.toString()).toBe("console.log('w')\n");
  });

  it("reflects file changes immediately (no cache)", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "one");
    const first = readWorkerBundle({ path: p })!.sha256;
    writeFileSync(p, "two");
    utimesSync(p, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(readWorkerBundle({ path: p })!.sha256).not.toBe(first);
  });
});

describe("readWorkerBundle", () => {
  it("returns null when the bundle file does not exist", () => {
    expect(readWorkerBundle({ path: join(dir, "nope.js") })).toBeNull();
  });

  it("reads bytes once and derives size + sha256 from the same buffer", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "console.log('w')\n");
    const want = createHash("sha256").update("console.log('w')\n").digest("hex");
    const got = readWorkerBundle({ path: p });
    expect(got).toMatchObject({ size: 17, sha256: want });
    expect(got!.bytes.toString()).toBe("console.log('w')\n");
  });
});

describe("bundleWorkerSha", () => {
  it("returns null when the sidecar .sha file does not exist", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "bundle");
    expect(bundleWorkerSha({ path: p })).toBeNull();
  });

  it("returns the trimmed sha when the sidecar file holds a valid 40-hex sha", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "bundle");
    const sha = "c".repeat(40);
    writeFileSync(`${p}.sha`, `${sha}\n`);
    expect(bundleWorkerSha({ path: p })).toBe(sha);
  });

  it("returns null when the sidecar file does not hold a valid 40-hex sha", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "bundle");
    writeFileSync(`${p}.sha`, "not-a-sha\n");
    expect(bundleWorkerSha({ path: p })).toBeNull();
  });
});

describe("box provisioning config", () => {
  it("defaults provisionMode to blank and rejects unknown values", () => {
    expect(config.box.provisionMode).toBe("blank");
    process.env.TASK_ORCH_BOX_PROVISION = "template";
    expect(config.box.provisionMode).toBe("template");
    process.env.TASK_ORCH_BOX_PROVISION = "wat";
    expect(() => config.box.provisionMode).toThrow(/TASK_ORCH_BOX_PROVISION/);
  });

  it("defaults provisionTimeoutSeconds to 300", () => {
    expect(config.box.provisionTimeoutSeconds).toBe(300);
    process.env.TASK_ORCH_BOX_PROVISION_TIMEOUT_S = "120";
    expect(config.box.provisionTimeoutSeconds).toBe(120);
  });
});
