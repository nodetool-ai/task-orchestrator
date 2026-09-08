import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { config } from "@/lib/config";

const PREFIX = "wc1";
const INSTANCE_ID_PATTERN = /^wi_[a-f0-9]{32}$/;

export type ChannelCredentialVerdict =
  | { ok: true; runId: number; instanceId: string; workerGeneration?: number }
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
  const secret = config.worker.channelSecret || process.env.AUTH_SECRET;
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

function validGeneration(workerGeneration: number): boolean {
  return Number.isSafeInteger(workerGeneration) && workerGeneration > 0;
}

function signature(runId: number, instanceId: string, workerGeneration: number, secret: string): string {
  // Preserve the original generation-1 credential byte-for-byte while legacy
  // workers are allowed to drain. Later generations use the explicit field in
  // both the token payload and signature input, so they cannot be replayed
  // across a process replacement.
  const scope = workerGeneration === 1
    ? `${PREFIX}:${runId}:${instanceId}`
    : `${PREFIX}:${runId}:${instanceId}:${workerGeneration}`;
  return createHmac("sha256", secret)
    .update(scope, "utf8")
    .digest("base64url");
}

/** Mint the stateless credential injected into exactly one worker instance. */
export function mintChannelCredential(
  runId: number,
  instanceId: string,
  options: ChannelCredentialOptions & { workerGeneration?: number } = {}
): string {
  if (!validRunId(runId)) throw new Error(`Invalid runId: ${runId}`);
  if (!validInstanceId(instanceId)) throw new Error(`Invalid channel instance id: ${instanceId}`);
  const workerGeneration = options.workerGeneration ?? 1;
  if (!validGeneration(workerGeneration)) throw new Error(`Invalid worker generation: ${workerGeneration}`);
  const secret = options.secret ?? channelCredentialSecret();
  if (!secret) throw new Error("Channel credential secret must not be empty");
  const payload = workerGeneration === 1 ? `${PREFIX}.${instanceId}` : `${PREFIX}.${instanceId}.${workerGeneration}`;
  return `${payload}.${signature(runId, instanceId, workerGeneration, secret)}`;
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
  options: ChannelCredentialOptions & { workerGeneration?: number } = {}
): ChannelCredentialVerdict {
  if (!validRunId(runId) || !validInstanceId(instanceId)) return { ok: false, reason: "malformed" };
  if (typeof token !== "string") return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  if (!validInstanceId(parts[1])) return { ok: false, reason: "malformed" };
  if (parts[1] !== instanceId) return { ok: false, reason: "instance-mismatch" };
  const workerGeneration = parts.length === 4 ? Number(parts[2]) : 1;
  if (!validGeneration(workerGeneration)) return { ok: false, reason: "malformed" };
  if ((options.workerGeneration ?? 1) !== workerGeneration) return { ok: false, reason: "instance-mismatch" };
  const signaturePart = parts.length === 4 ? parts[3] : parts[2];
  if (!/^[A-Za-z0-9_-]{43}$/.test(signaturePart)) return { ok: false, reason: "malformed" };

  let secret: string;
  try {
    secret = options.secret ?? channelCredentialSecret();
  } catch {
    return { ok: false, reason: "missing-secret" };
  }

  const expected = Buffer.from(signature(runId, instanceId, workerGeneration, secret), "utf8");
  const given = Buffer.from(signaturePart, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad-signature" };
  }
  return workerGeneration === 1 && parts.length === 3
    ? { ok: true, runId, instanceId }
    : { ok: true, runId, instanceId, workerGeneration };
}

/** Generate the exact worker-instance identifier used by the channel. */
export function newChannelInstanceId(): string {
  return `wi_${randomBytes(16).toString("hex")}`;
}

export { INSTANCE_ID_PATTERN };
