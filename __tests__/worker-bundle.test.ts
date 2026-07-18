// __tests__/worker-bundle.test.ts
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateWorkerBundle } from "../lib/worker-bundle";
import { config } from "../lib/config";

const KNOBS = ["TASK_ORCH_BOX_PROVISION", "TASK_ORCH_BUNDLE_URL", "AUTH_URL", "TASK_ORCH_BOX_PROVISION_TIMEOUT_S"];
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

describe("locateWorkerBundle", () => {
  it("returns null when the bundle file does not exist", () => {
    expect(locateWorkerBundle({ path: join(dir, "nope.js") })).toBeNull();
  });

  it("returns path, size, and sha256 of the bundle", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "console.log('w')\n");
    const want = createHash("sha256").update("console.log('w')\n").digest("hex");
    const got = locateWorkerBundle({ path: p });
    expect(got).toMatchObject({ path: p, size: 17, sha256: want });
  });

  it("recomputes the hash when the file changes", () => {
    const p = join(dir, "run-worker.standalone.js");
    writeFileSync(p, "one");
    const first = locateWorkerBundle({ path: p })!.sha256;
    writeFileSync(p, "two");
    utimesSync(p, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    expect(locateWorkerBundle({ path: p })!.sha256).not.toBe(first);
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

  it("derives bundleUrl from AUTH_URL and prefers the explicit override", () => {
    expect(config.box.bundleUrl).toBeUndefined();
    process.env.AUTH_URL = "https://tasks.example.com/";
    expect(config.box.bundleUrl).toBe("https://tasks.example.com/api/worker-bundle");
    process.env.TASK_ORCH_BUNDLE_URL = "https://cdn.example.com/wb";
    expect(config.box.bundleUrl).toBe("https://cdn.example.com/wb");
  });

  it("defaults provisionTimeoutSeconds to 300", () => {
    expect(config.box.provisionTimeoutSeconds).toBe(300);
    process.env.TASK_ORCH_BOX_PROVISION_TIMEOUT_S = "120";
    expect(config.box.provisionTimeoutSeconds).toBe(120);
  });
});
