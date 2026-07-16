import { describe, expect, it, afterEach, beforeEach } from "vitest";
import {
  mintChannelCredential,
  newChannelInstanceId,
  verifyChannelCredential,
} from "../lib/worker-channel/credential";

const RUN_ID = 42;
const INSTANCE_ID = "wi_0123456789abcdef0123456789abcdef";
const FOREIGN_INSTANCE_ID = "wi_fedcba9876543210fedcba9876543210";

describe("worker channel credentials", () => {
  let oldChannelSecret: string | undefined;
  let oldAuthSecret: string | undefined;

  beforeEach(() => {
    oldChannelSecret = process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
    oldAuthSecret = process.env.AUTH_SECRET;
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "channel-secret-a";
    delete process.env.AUTH_SECRET;
  });

  afterEach(() => {
    if (oldChannelSecret === undefined) delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
    else process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = oldChannelSecret;
    if (oldAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = oldAuthSecret;
  });

  it("generates the exact wi_ instance-id format", () => {
    const instanceId = newChannelInstanceId();
    expect(instanceId).toMatch(/^wi_[a-f0-9]{32}$/);
  });

  it("mints and verifies a run- and instance-scoped credential", () => {
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    expect(token).toMatch(/^wc1\.wi_[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyChannelCredential(token, RUN_ID, INSTANCE_ID)).toEqual({
      ok: true,
      runId: RUN_ID,
      instanceId: INSTANCE_ID,
    });
  });

  it("rejects a credential for another run", () => {
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    expect(verifyChannelCredential(token, RUN_ID + 1, INSTANCE_ID)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a credential for another instance before signature use", () => {
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    expect(verifyChannelCredential(token, RUN_ID, FOREIGN_INSTANCE_ID)).toEqual({
      ok: false,
      reason: "instance-mismatch",
    });
  });

  it("returns typed failures and never throws for attacker-controlled text", () => {
    const inputs: unknown[] = [
      "",
      "not-a-token",
      "wt1." + INSTANCE_ID + ".signature",
      "wc1.bad-instance.signature",
      "wc1." + INSTANCE_ID,
      "wc1." + INSTANCE_ID + ".short",
      null,
      42,
      { toString: () => { throw new Error("should not be called"); } },
    ];
    for (const input of inputs) {
      expect(() => verifyChannelCredential(input, RUN_ID, INSTANCE_ID)).not.toThrow();
      expect(verifyChannelCredential(input, RUN_ID, INSTANCE_ID).ok).toBe(false);
    }
  });

  it("invalidates credentials after secret rotation", () => {
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "channel-secret-b";
    expect(verifyChannelCredential(token, RUN_ID, INSTANCE_ID)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const replacement = mintChannelCredential(RUN_ID, INSTANCE_ID);
    expect(verifyChannelCredential(replacement, RUN_ID, INSTANCE_ID).ok).toBe(true);
  });

  it("uses AUTH_SECRET only as the fallback secret", () => {
    delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
    process.env.AUTH_SECRET = "auth-fallback";
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    expect(verifyChannelCredential(token, RUN_ID, INSTANCE_ID).ok).toBe(true);
  });

  it("uses a timing-safe comparison for same-length bad signatures", () => {
    const token = mintChannelCredential(RUN_ID, INSTANCE_ID);
    const parts = token.split(".");
    const last = parts[2];
    parts[2] = (last[0] === "A" ? "B" : "A") + last.slice(1);
    expect(verifyChannelCredential(parts.join("."), RUN_ID, INSTANCE_ID)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects malformed mint inputs", () => {
    expect(() => mintChannelCredential(0, INSTANCE_ID)).toThrow(/runId/);
    expect(() => mintChannelCredential(RUN_ID, "wi_ABC")).toThrow(/instance id/);
    expect(() => mintChannelCredential(RUN_ID, "not-an-instance")).toThrow(/instance id/);
  });
});
