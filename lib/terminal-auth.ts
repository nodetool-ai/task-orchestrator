import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 60_000;

function secret(): string {
  return (
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET ??
    "dev-terminal-secret-change-me"
  );
}

export function signToken(runId: number): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `${runId}:${exp}`;
  const sig = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}:${sig}`;
}

export function verifyToken(token: string): { runId: number } | null {
  const parts = token.split(":");
  if (parts.length !== 3) return null;
  const [runIdStr, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp) || Date.now() > exp) return null;
  const payload = `${runIdStr}:${expStr}`;
  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  try {
    const sigBuf = Buffer.from(sig, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  } catch {
    return null;
  }
  const runId = parseInt(runIdStr, 10);
  if (Number.isNaN(runId)) return null;
  return { runId };
}
