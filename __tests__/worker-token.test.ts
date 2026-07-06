// __tests__/worker-token.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_TOKEN_TTL_MS,
  authorizeWorkerRequest,
  mintWorkerToken,
  verifyWorkerToken,
  workerDispatchEnv,
} from "../lib/worker/token";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.TASK_ORCH_WORKER_API_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.TASK_ORCH_WORKER_API_SECRET;
  delete process.env.TASK_ORCH_WORKER_API_URL;
});

describe("worker tokens", () => {
  it("mints and verifies a run-scoped token", () => {
    const token = mintWorkerToken(42);
    expect(token).toMatch(/^wt1\.42\.\d+\./);
    expect(verifyWorkerToken(token)).toEqual({ ok: true, runId: 42 });
  });

  it("rejects a tampered payload", () => {
    const token = mintWorkerToken(42);
    const forged = token.replace(".42.", ".43.");
    expect(verifyWorkerToken(forged)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintWorkerToken(42, { secret: "other" });
    expect(verifyWorkerToken(token)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects an expired token (but not a live one)", () => {
    const token = mintWorkerToken(42, { ttlMs: 1000 });
    expect(verifyWorkerToken(token)).toEqual({ ok: true, runId: 42 });
    expect(verifyWorkerToken(token, { now: Date.now() + 2000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("has a default TTL long enough for multi-hour runs", () => {
    expect(DEFAULT_WORKER_TOKEN_TTL_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("rejects malformed tokens", () => {
    for (const bad of ["", "wt1", "wt1.x.y.z", "nope.42.99999999999.sig", "wt1.42.notanum.sig"]) {
      expect(verifyWorkerToken(bad).ok).toBe(false);
    }
  });
});

describe("authorizeWorkerRequest", () => {
  const req = (auth?: string) =>
    new Request("http://x/api/worker/runs/42", {
      headers: auth ? { authorization: auth } : {},
    });

  it("accepts a bearer token scoped to the expected run", () => {
    const r = authorizeWorkerRequest(req(`Bearer ${mintWorkerToken(42)}`), 42);
    expect(r).toEqual({ ok: true, runId: 42 });
  });

  it("403s a token for a different run", () => {
    const r = authorizeWorkerRequest(req(`Bearer ${mintWorkerToken(41)}`), 42);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("401s a missing or non-bearer header", () => {
    expect(authorizeWorkerRequest(req(), 42)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWorkerRequest(req("Basic abc"), 42)).toMatchObject({ ok: false, status: 401 });
  });
});

describe("workerDispatchEnv", () => {
  it("is null when the server does not advertise a worker API url", () => {
    expect(workerDispatchEnv(7)).toBeNull();
  });

  it("hands out the url plus a token scoped to the run", () => {
    process.env.TASK_ORCH_WORKER_API_URL = "http://orchestrator:3000";
    const env = workerDispatchEnv(7)!;
    expect(env.TASK_ORCH_WORKER_API_URL).toBe("http://orchestrator:3000");
    expect(verifyWorkerToken(env.TASK_ORCH_WORKER_TOKEN)).toEqual({ ok: true, runId: 7 });
  });
});
