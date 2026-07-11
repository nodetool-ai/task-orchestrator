import { SignJWT, jwtVerify } from "jose";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // Fail closed in production: a hardcoded fallback would let anyone forge a
    // magic-link JWT in a misconfigured deploy. A dev-only fallback keeps local
    // development working without configuring a secret.
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Magic-link tokens need a signing secret: set AUTH_SECRET (or NEXTAUTH_SECRET)."
      );
    }
    return new TextEncoder().encode("dev-only-insecure-secret");
  }
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
