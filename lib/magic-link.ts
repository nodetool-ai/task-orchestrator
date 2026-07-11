import { randomUUID } from "node:crypto";
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
  // `jti` is a per-token unique id. It is minted here so single-use enforcement
  // becomes possible: a consumed-jti store can reject a token whose jti has
  // already been redeemed. Without such a store the token is still replayable
  // for its full lifetime (see verifyMagicToken).
  return new SignJWT({ email: email.toLowerCase().trim(), type: "magic-link" })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${EXPIRY_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyMagicToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      clockTolerance: 30,
      requiredClaims: ["email", "type", "jti"],
    });
    if (payload.type !== "magic-link") return null;
    // TODO: enforce single-use via consumed-jti store. The token now carries a
    // `jti` (payload.jti), but there is no persistence layer to record redeemed
    // jtis, so the token remains replayable until it expires. Enforcement should
    // live at the consumption site (auth.ts authorize), not here — this function
    // is also called by app/login-link/page.tsx just to render the email, and
    // consuming the jti there would burn the token before the user logs in.
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
