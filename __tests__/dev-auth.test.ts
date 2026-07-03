import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { db } from "../db";
import { users } from "../db/schema";
import { isAuthDisabled, DEV_USER_EMAIL } from "../lib/auth-mode";
import { ensureDevUser } from "../lib/users";

describe("isAuthDisabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isAuthDisabled()).toBe(true);
  });

  it("is false in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthDisabled()).toBe(false);
  });

  it("is false in test (auth stays enforced under vitest)", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isAuthDisabled()).toBe(false);
  });
});

describe("ensureDevUser", () => {
  beforeEach(async () => {
    await db.delete(users);
  });

  it("creates the local dev user when none exists", async () => {
    const user = await ensureDevUser();
    expect(user.email).toBe(DEV_USER_EMAIL);
    expect(user.id).toBeTypeOf("number");
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("is idempotent — returns the same user without duplicating", async () => {
    const first = await ensureDevUser();
    const second = await ensureDevUser();
    expect(second.id).toBe(first.id);
    expect(await db.select().from(users)).toHaveLength(1);
  });
});
