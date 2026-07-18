// __tests__/worker-bundle-route.test.ts
//
// The bundle route is what a blank-provisioned box curls at launch. Auth is
// the run-scoped channel HMAC (or an operator API token / session); the
// sha256 header is what the box verifies after download.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { runnerInstances } from "../db/schema";
import { create } from "../lib/runs";
import { mintChannelCredential, newChannelInstanceId } from "../lib/worker-channel/credential";

vi.mock("../auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("../lib/api-tokens", () => ({
  verifyToken: vi.fn(async (t: string) => (t === "valid-api-token" ? { id: 1, userId: 1 } : null)),
}));

import { GET } from "../app/api/worker-bundle/route";

let dir: string;
const SECRET_KEY = "TASK_ORCH_WORKER_CHANNEL_SECRET";
let savedSecret: string | undefined;
let savedBundlePath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-route-"));
  savedSecret = process.env[SECRET_KEY];
  process.env[SECRET_KEY] = "test-channel-secret";
  savedBundlePath = process.env.TASK_ORCH_BUNDLE_PATH;
  process.env.TASK_ORCH_WORKER_SHA = "a".repeat(40);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSecret == null) delete process.env[SECRET_KEY];
  else process.env[SECRET_KEY] = savedSecret;
  if (savedBundlePath == null) delete process.env.TASK_ORCH_BUNDLE_PATH;
  else process.env.TASK_ORCH_BUNDLE_PATH = savedBundlePath;
  delete process.env.TASK_ORCH_WORKER_SHA;
  vi.clearAllMocks();
});

function writeBundle(content: string): string {
  const p = join(dir, "run-worker.standalone.js");
  writeFileSync(p, content);
  process.env.TASK_ORCH_BUNDLE_PATH = p;
  return p;
}

async function seededRun(): Promise<{ runId: number; instanceId: string; credential: string }> {
  const run = await create({ goal: "<implement>", defer: true });
  const instanceId = newChannelInstanceId();
  await db.insert(runnerInstances).values({
    runId: run.id,
    provider: "box",
    state: "starting",
    repoPath: "/home/user/repository",
    channelInstanceId: instanceId,
    credentialsVersion: 1,
  });
  return { runId: run.id, instanceId, credential: mintChannelCredential(run.id, instanceId) };
}

function get(headers: Record<string, string> = {}): Request {
  return new Request("http://test/api/worker-bundle", { headers });
}

describe("GET /api/worker-bundle", () => {
  it("serves the bundle with sha256 and worker-sha headers for a valid channel credential", async () => {
    writeBundle("bundle-bytes");
    const { runId, credential } = await seededRun();
    const res = await GET(get({ authorization: `Bearer ${credential}`, "x-run-id": String(runId) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-bundle-sha256")).toBe(
      createHash("sha256").update("bundle-bytes").digest("hex")
    );
    expect(res.headers.get("x-worker-sha")).toBe("a".repeat(40));
    expect(await res.text()).toBe("bundle-bytes");
  });

  it("rejects a credential minted for a different run", async () => {
    writeBundle("bundle-bytes");
    const a = await seededRun();
    const b = await seededRun();
    const res = await GET(get({ authorization: `Bearer ${a.credential}`, "x-run-id": String(b.runId) }));
    expect(res.status).toBe(401);
  });

  it("rejects when the run has no runner instance", async () => {
    writeBundle("bundle-bytes");
    const run = await create({ goal: "<implement>", defer: true });
    const cred = mintChannelCredential(run.id, newChannelInstanceId());
    const res = await GET(get({ authorization: `Bearer ${cred}`, "x-run-id": String(run.id) }));
    expect(res.status).toBe(401);
  });

  it("accepts an operator API token without a run id", async () => {
    writeBundle("bundle-bytes");
    const res = await GET(get({ authorization: "Bearer valid-api-token" }));
    expect(res.status).toBe(200);
  });

  it("returns 503 naming the build command when the bundle is missing", async () => {
    process.env.TASK_ORCH_BUNDLE_PATH = join(dir, "missing.js");
    const res = await GET(get({ authorization: "Bearer valid-api-token" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("build:worker:standalone");
  });

  it("rejects with no auth at all", async () => {
    writeBundle("bundle-bytes");
    const res = await GET(get());
    expect(res.status).toBe(401);
  });
});
