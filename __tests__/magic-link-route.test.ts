import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/auth/magic-link/route";
import { db } from "../db";
import { users } from "../db/schema";

const EXISTING_EMAIL = "victim@test.local";
const MISSING_EMAIL = "nobody@test.local";

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/magic-link", () => {
  beforeEach(async () => {
    await db.delete(users);
    await db.insert(users)
      .values({ email: EXISTING_EMAIL, passwordHash: "x" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("production (auth enabled)", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "production");
    });

    it("returns {ok:true} with NO url for an existing email", async () => {
      const res = await POST(makeReq({ email: EXISTING_EMAIL }) as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(body.url).toBeUndefined();
    });

    it("returns an identical {ok:true} with NO url for a non-existing email", async () => {
      const res = await POST(makeReq({ email: MISSING_EMAIL }) as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(body.url).toBeUndefined();
    });

    it("gives byte-identical responses for existing and non-existing emails (no enumeration oracle)", async () => {
      const existing = await (
        await POST(makeReq({ email: EXISTING_EMAIL }) as never)
      ).json();
      const missing = await (
        await POST(makeReq({ email: MISSING_EMAIL }) as never)
      ).json();
      expect(existing).toEqual(missing);
    });
  });

  describe("development (auth disabled)", () => {
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", "development");
    });

    it("returns a login url for an existing user", async () => {
      const res = await POST(makeReq({ email: EXISTING_EMAIL }) as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(typeof body.url).toBe("string");
      expect(body.url).toContain("/login-link?token=");
    });

    it("still returns {ok:true} with NO url for a non-existing user", async () => {
      const res = await POST(makeReq({ email: MISSING_EMAIL }) as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(body.url).toBeUndefined();
    });
  });

  describe("validation", () => {
    it("rejects an invalid email with 400", async () => {
      const res = await POST(makeReq({ email: "not-an-email" }) as never);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid email");
    });

    it("rejects a missing email with 400", async () => {
      const res = await POST(makeReq({}) as never);
      expect(res.status).toBe(400);
    });
  });
});
