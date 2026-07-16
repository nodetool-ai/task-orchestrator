import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "wc1";
const INSTANCE_ID_PATTERN = /^wi_[a-f0-9]{32}$/;

export type ChannelCredentialVerdict =
  | { ok: true; runId: number; instanceId: string }
  | {
      ok: false;
      reason: "malformed" | "instance-mismatch" | "bad-signature" | "missing-secret";
    };

export interface ChannelCredentialOptions {
  secret?: string;
}

/** Resolve the channel-only signing secret. It is deliberately not the old
 * worker HTTP API secret: rotating this secret rotates instance credentials. */
export function channelCredentialSecret(): string {
  const secret = process.env.TASK_ORCH_WORKER_CHANNEL_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Worker channel credentials need a signing secret: set TASK_ORCH_WORKER_CHANNEL_SECRET (or AUTH_SECRET)."
    );
  }
  return secret;
}

function validRunId(runId: number): boolean {
  return Number.isInteger(runId) && runId > 0;
}

function validInstanceId(instanceId: string): boolean {
  return typeof instanceId === "string" && INSTANCE_ID_PATTERN.test(instanceId);
}

function signature(runId: number, instanceId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${PREFIX}:${runId}:${instanceId}`, "utf8")
    .digest("base64url");
}

/** Mint the stateless credential injected into exactly one worker instance. */
export function mintChannelCredential(
  runId: number,
  instanceId: string,
  options: ChannelCredentialOptions = {}
): string {
  if (!validRunId(runId)) throw new Error(`Invalid runId: ${runId}`);
  if (!validInstanceId(instanceId)) throw new Error(`Invalid channel instance id: ${instanceId}`);
  const secret = options.secret ?? channelCredentialSecret();
  if (!secret) throw new Error("Channel credential secret must not be empty");
  const payload = `${PREFIX}.${instanceId}`;
  return `${payload}.${signature(runId, instanceId, secret)}`;
}

/**
 * Verify untrusted bearer text without throwing. A run mismatch has no
 * distinguishable token field (the run id is authenticated inside the HMAC),
 * so it correctly falls into bad-signature; an instance mismatch is visible
 * from the second token component and receives its own typed verdict.
 */
export function verifyChannelCredential(
  token: unknown,
  runId: number,
  instanceId: string,
  options: ChannelCredentialOptions = {}
): ChannelCredentialVerdict {
  if (!validRunId(runId) || !validInstanceId(instanceId)) return { ok: false, reason: "malformed" };
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  if (!validInstanceId(parts[1])) return { ok: false, reason: "malformed" };
  if (parts[1] !== instanceId) return { ok: false, reason: "instance-mismatch" };
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return { ok: false, reason: "malformed" };

  let secret: string;
  try {
    secret = options.secret ?? channelCredentialSecret();
  } catch {
    return { ok: false, reason: "missing-secret" };
  }

  const expected = Buffer.from(signature(runId, instanceId, secret), "utf8");
  const given = Buffer.from(parts[2], "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, runId, instanceId };
}

/** Generate the exact worker-instance identifier used by the channel. */
export function newChannelInstanceId(): string {
  return `wi_${randomBytes(16).toString("hex")}`;
}

export { INSTANCE_ID_PATTERN };
