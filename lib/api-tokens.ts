// API token issuance + verification for the MCP HTTP endpoint.
//
// Tokens look like `tot_<43 base64url chars>`; the `tot_` (Task
// Orchestrator Token) tag makes them grep-friendly and guarantees they
// fail any base64-shaped probe. The plaintext is shown ONCE at creation
// and never persisted — the DB stores a bcrypt hash plus the first 8
// plaintext chars so the UI can identify a token without exposing the
// secret.

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "@/db";
import { apiTokens, type ApiToken } from "@/db/schema";

const BCRYPT_ROUNDS = 10;
const TOKEN_PREFIX = "tot_";
const PREFIX_DISPLAY_LEN = 8; // chars after "tot_" we keep for UI display

function generatePlaintext(): string {
  // 32 random bytes → 43 base64url chars (no padding).
  const raw = randomBytes(32);
  const b64 = raw
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return TOKEN_PREFIX + b64;
}

export interface CreatedToken {
  id: number;
  /** Plaintext — only available at creation. Show once, then forget. */
  token: string;
  prefix: string;
  name: string;
}

export async function createToken(
  userId: number,
  name: string
): Promise<CreatedToken> {
  if (!name.trim()) throw new Error("Token name is required");
  const token = generatePlaintext();
  const tokenHash = await bcrypt.hash(token, BCRYPT_ROUNDS);
  const prefix = token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + PREFIX_DISPLAY_LEN);
  const inserted = await db
    .insert(apiTokens)
    .values({ userId, name: name.trim(), tokenHash, prefix })
    .returning();
  const row = inserted[0];
  return { id: row.id, token, prefix, name: row.name };
}

export interface VerifiedToken {
  tokenId: number;
  userId: number;
}

/**
 * Validate a plaintext token. Returns { tokenId, userId } on success,
 * null on failure. Side-effect: bumps last_used_at on success.
 *
 * Implementation: lookup by prefix (cheap index hit) then bcrypt-compare
 * against the matching candidates. On miss, do one dummy compare to keep
 * the timing roughly constant.
 */
export async function verifyToken(plaintext: string): Promise<VerifiedToken | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const prefix = plaintext.slice(
    TOKEN_PREFIX.length,
    TOKEN_PREFIX.length + PREFIX_DISPLAY_LEN
  );
  const candidates = await db
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      hash: apiTokens.tokenHash,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.prefix, prefix), isNull(apiTokens.revokedAt)));
  for (const c of candidates) {
    if (await bcrypt.compare(plaintext, c.hash)) {
      await db.update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, c.id));
      return { tokenId: c.id, userId: c.userId };
    }
  }
  // Constant-time miss.
  await bcrypt.compare(plaintext, "$2a$10$" + "x".repeat(53));
  return null;
}

export interface TokenSummary {
  id: number;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listTokens(userId: number): Promise<TokenSummary[]> {
  return (await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.prefix,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))) as TokenSummary[];
}

export async function revokeToken(id: number, userId: number): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)));
  return result.count > 0;
}

/**
 * Revoke a token on behalf of the SYSTEM — no owning-user check, because the
 * caller has already proven possession of the plaintext (verifyToken) rather
 * than being the logged-in owner. Used by consume-on-link (`/link` in the
 * Discord pipe): a link token is a one-time proof, so it is burned as it is
 * accepted and can never be replayed to re-point the identity.
 *
 * Atomic claim: the `revoked_at IS NULL` predicate lives in the WHERE clause, so
 * exactly one of two concurrent consumers gets `true`.
 */
export async function consumeToken(id: number): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)));
  return result.count > 0;
}

export async function getToken(id: number, userId: number): Promise<ApiToken | null> {
  const row = (await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
  )[0];
  return row ?? null;
}
