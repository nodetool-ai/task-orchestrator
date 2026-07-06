// lib/worker/token.ts
//
// Run-scoped bearer tokens for the worker HTTP API (/api/worker/*).
//
// The server mints one token per dispatched run and hands it to the worker via
// TASK_ORCH_WORKER_TOKEN. The token is stateless (HMAC-signed, no DB row):
//
//   wt1.<runId>.<expiresAtEpochSeconds>.<base64url(hmac-sha256(payload))>
//
// A token authorizes exactly ONE run's lifecycle endpoints (plus the read-only
// task/plan/persona context endpoints a turn needs). It is NOT a user API
// token: it cannot list runs, create runs, or touch other runs.
//
// Secret resolution: TASK_ORCH_WORKER_API_SECRET, falling back to AUTH_SECRET
// (already required in production for Auth.js). Rotating the secret invalidates
// in-flight workers' tokens — their next call 401s and the run is reaped by the
// heartbeat lease like any dead worker, so rotation is safe, just disruptive.

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "wt1";

/** Default token lifetime. Generous: it must outlive the longest plausible run
 *  (multi-hour executors), not a browser session. */
export const DEFAULT_WORKER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function workerTokenSecret(): string {
  const secret = process.env.TASK_ORCH_WORKER_API_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Worker API tokens need a signing secret: set TASK_ORCH_WORKER_API_SECRET (or AUTH_SECRET)."
    );
  }
  return secret;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintWorkerToken(
  runId: number,
  opts: { ttlMs?: number; secret?: string; now?: number } = {}
): string {
  if (!Number.isInteger(runId) || runId <= 0) throw new Error(`Invalid runId: ${runId}`);
  const secret = opts.secret ?? workerTokenSecret();
  const exp = Math.floor(((opts.now ?? Date.now()) + (opts.ttlMs ?? DEFAULT_WORKER_TOKEN_TTL_MS)) / 1000);
  const payload = `${PREFIX}.${runId}.${exp}`;
  return `${payload}.${sign(payload, secret)}`;
}

export type WorkerTokenVerdict =
  | { ok: true; runId: number }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

export function verifyWorkerToken(
  token: string,
  opts: { secret?: string; now?: number } = {}
): WorkerTokenVerdict {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const runId = parseInt(parts[1], 10);
  const exp = parseInt(parts[2], 10);
  if (!Number.isInteger(runId) || runId <= 0 || !Number.isInteger(exp)) {
    return { ok: false, reason: "malformed" };
  }
  const payload = `${PREFIX}.${parts[1]}.${parts[2]}`;
  const expected = Buffer.from(sign(payload, opts.secret ?? workerTokenSecret()));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad-signature" };
  }
  if ((opts.now ?? Date.now()) / 1000 >= exp) return { ok: false, reason: "expired" };
  return { ok: true, runId };
}

/** Extract + verify the bearer token from a Request, scoped to `runId` when
 *  given. Returns the authorized runId or a { status, error } rejection. */
export function authorizeWorkerRequest(
  req: Request,
  expectedRunId?: number
): { ok: true; runId: number } | { ok: false; status: number; error: string } {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, status: 401, error: "Missing bearer token" };
  let verdict: WorkerTokenVerdict;
  try {
    verdict = verifyWorkerToken(m[1]);
  } catch (e) {
    // No signing secret configured server-side.
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
  if (!verdict.ok) return { ok: false, status: 401, error: `Invalid worker token (${verdict.reason})` };
  if (expectedRunId != null && verdict.runId !== expectedRunId) {
    return { ok: false, status: 403, error: "Token is not scoped to this run" };
  }
  return { ok: true, runId: verdict.runId };
}
