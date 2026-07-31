import { describe, expect, it, beforeEach } from "vitest";
import { db } from "../db";
import { apiTokens, users } from "../db/schema";
import {
  consumeToken,
  createToken,
  verifyToken,
  listTokens,
  revokeToken,
} from "../lib/api-tokens";

async function freshUser(email = "tokens@test.local"): Promise<number> {
  await db.delete(apiTokens);
  (await db.delete(users).where(undefined as never)).count; // no-op (TS shape guard)
  const inserted = await db
    .insert(users)
    .values({ email, passwordHash: "x" })
    .returning();
  return inserted[0].id;
}

describe("api tokens", () => {
  let userId: number;

  beforeEach(async () => {
    await db.delete(apiTokens);
    await db.delete(users);
    const inserted = await db
      .insert(users)
      .values({ email: "tokens@test.local", passwordHash: "x" })
      .returning();
    userId = inserted[0].id;
  });

  it("createToken returns a tot_-prefixed plaintext", async () => {
    const t = await createToken(userId, "test");
    expect(t.token.startsWith("tot_")).toBe(true);
    expect(t.token.length).toBeGreaterThan(20);
  });

  it("createToken trims and rejects empty names", async () => {
    await expect(createToken(userId, "  ")).rejects.toThrow(/name/i);
  });

  it("verifyToken accepts a freshly created plaintext", async () => {
    const t = await createToken(userId, "ok");
    const v = await verifyToken(t.token);
    expect(v).not.toBeNull();
    expect(v!.userId).toBe(userId);
    expect(v!.tokenId).toBe(t.id);
  });

  it("verifyToken rejects garbage", async () => {
    expect(await verifyToken("nope")).toBeNull();
    expect(await verifyToken("tot_aaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("verifyToken rejects revoked tokens", async () => {
    const t = await createToken(userId, "revoked");
    await revokeToken(t.id, userId);
    expect(await verifyToken(t.token)).toBeNull();
  });

  it("verifyToken bumps last_used_at", async () => {
    const t = await createToken(userId, "trace");
    expect((await listTokens(userId))[0].lastUsedAt).toBeNull();
    await verifyToken(t.token);
    const after = (await listTokens(userId))[0];
    expect(after.lastUsedAt).toBeInstanceOf(Date);
  });

  it("listTokens shows metadata only, no plaintext", async () => {
    await createToken(userId, "alpha");
    await createToken(userId, "beta");
    const list = await listTokens(userId);
    expect(list.length).toBe(2);
    expect(list[0].name).toBeDefined();
    expect(list[0].prefix.length).toBe(8);
    // No plaintext leaks through the summary type:
    expect(Object.keys(list[0])).not.toContain("token");
    expect(Object.keys(list[0])).not.toContain("tokenHash");
  });

  it("consumeToken burns a token exactly once (single-use link tokens)", async () => {
    const t = await createToken(userId, "link");
    // No owning-user argument: the caller proved possession of the plaintext,
    // it isn't acting as the logged-in owner (see /link, design §2).
    expect(await consumeToken(t.id)).toBe(true);
    expect(await consumeToken(t.id)).toBe(false); // a replay claims nothing
    expect(await verifyToken(t.token)).toBeNull();
    expect((await listTokens(userId))[0].revokedAt).toBeInstanceOf(Date);
  });

  it("consumeToken lets exactly one of two racing claims win", async () => {
    const t = await createToken(userId, "race");
    const results = await Promise.all([consumeToken(t.id), consumeToken(t.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("revokeToken only works for the owning user", async () => {
    const otherUser = (await db
      .insert(users)
      .values({ email: "other@test.local", passwordHash: "x" })
      .returning())[0].id;
    const t = await createToken(userId, "mine");
    expect(await revokeToken(t.id, otherUser)).toBe(false);
    const v = await verifyToken(t.token);
    expect(v).not.toBeNull();
  });
});
