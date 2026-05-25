import { SignJWT, jwtVerify } from "jose";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "fallback-secret-change-me";
  return new TextEncoder().encode(secret);
}

const EXPIRY_SECONDS = 3600; // 1 hour

export async function createMagicToken(email: string): Promise<string> {
  return new SignJWT({ email: email.toLowerCase().trim(), type: "magic-link" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${EXPIRY_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      clockTolerance: 30,
      requiredClaims: ["email", "type"],
    });
    if (payload.type !== "magic-link") return null;
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
