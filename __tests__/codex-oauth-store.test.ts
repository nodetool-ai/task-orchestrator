import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { codexCredentials, codexLoginAttempts } from "../db/schema";
import {
  codexAuthStatus,
  codexLogout,
  completeCodexLogin,
  resolveStoredAccessToken,
  saveCodexTokens,
  startCodexLogin,
} from "../lib/codex-oauth-store";
import { CODEX_DEVICE_VERIFICATION_URL } from "../lib/codex-oauth-login";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const expiringIn = (seconds: number) => jwt({ exp: Math.floor(Date.now() / 1000) + seconds });

function deviceCodeResponse(id = "device-123", code = "ABCD-EFGH", interval = "2") {
  return {
    ok: true,
    status: 200,
    json: async () => ({ device_auth_id: id, user_code: code, interval }),
  };
}

beforeEach(async () => {
  await db.delete(codexCredentials);
  await db.delete(codexLoginAttempts);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveCodexTokens", () => {
  it("stores the credential, decodes the account id and expiry, and upserts on re-login", async () => {
    const access = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });
    const status = await saveCodexTokens({ access_token: access, refresh_token: "ref" });
    expect(status).toMatchObject({ signedIn: true, accountId: "acct-1" });
    expect(status.expiresAt).toEqual(expect.any(String));

    await saveCodexTokens({ access_token: jwt({ sub: "acct-2" }), refresh_token: "ref2" });
    const rows = await db.select().from(codexCredentials);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("acct-2");
    expect(rows[0].refreshToken).toBe("ref2");
  });
});

describe("startCodexLogin", () => {
  it("returns and persists the OpenAI device code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => deviceCodeResponse()));
    const device = await startCodexLogin();
    expect(device).toEqual({
      deviceAuthId: "device-123",
      userCode: "ABCD-EFGH",
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
      intervalSeconds: 2,
    });

    const [attempt] = await db.select().from(codexLoginAttempts);
    expect(attempt).toMatchObject({
      deviceAuthId: "device-123",
      userCode: "ABCD-EFGH",
      intervalSeconds: 2,
    });
  });

  it("replaces an older pending attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse("old", "OLD"))
      .mockResolvedValueOnce(deviceCodeResponse("new", "NEW"));
    vi.stubGlobal("fetch", fetchMock);
    await startCodexLogin();
    await startCodexLogin();
    expect(await db.select().from(codexLoginAttempts)).toMatchObject([
      { deviceAuthId: "new", userCode: "NEW" },
    ]);
  });
});

describe("completeCodexLogin", () => {
  it("keeps the attempt while authorization is pending", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
    const device = await startCodexLogin();

    await expect(completeCodexLogin(device.deviceAuthId)).resolves.toMatchObject({
      signedIn: false,
      pending: true,
    });
    expect(await db.select().from(codexLoginAttempts)).toHaveLength(1);
  });

  it("exchanges an approved device authorization and burns the attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResponse())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          authorization_code: "auth-code",
          code_challenge: "challenge",
          code_verifier: "server-verifier",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: expiringIn(3600), refresh_token: "ref" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const device = await startCodexLogin();

    await expect(completeCodexLogin(device.deviceAuthId)).resolves.toMatchObject({
      signedIn: true,
      pending: false,
    });
    expect(await db.select().from(codexLoginAttempts)).toHaveLength(0);

    const tokenBody = new URLSearchParams(
      (fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1].body as string
    );
    expect(tokenBody.get("code")).toBe("auth-code");
    expect(tokenBody.get("code_verifier")).toBe("server-verifier");
  });

  it("rejects an unknown or consumed device auth id", async () => {
    await expect(completeCodexLogin("missing")).rejects.toThrow(/expired or was already used/);
  });
});

describe("resolveStoredAccessToken", () => {
  it("returns a live token untouched", async () => {
    const access = expiringIn(3600);
    await saveCodexTokens({ access_token: access, refresh_token: "ref" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should not refresh"); }));
    await expect(resolveStoredAccessToken()).resolves.toBe(access);
  });

  it("refreshes a near-expiry token and writes the rotated pair back", async () => {
    await saveCodexTokens({ access_token: expiringIn(30), refresh_token: "old-ref" });
    const rotated = expiringIn(3600);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: rotated, refresh_token: "new-ref" }),
    })));

    await expect(resolveStoredAccessToken()).resolves.toBe(rotated);
    const [row] = await db.select().from(codexCredentials);
    expect(row.accessToken).toBe(rotated);
    expect(row.refreshToken).toBe("new-ref");
  });

  it("falls back to the stale token when refresh fails", async () => {
    const stale = expiringIn(30);
    await saveCodexTokens({ access_token: stale, refresh_token: "old-ref" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "" })));
    await expect(resolveStoredAccessToken()).resolves.toBe(stale);
  });

  it("returns undefined when nothing is stored", async () => {
    await expect(resolveStoredAccessToken()).resolves.toBeUndefined();
  });
});

describe("codexLogout", () => {
  it("revokes, clears the credential, and drops outstanding attempts", async () => {
    await saveCodexTokens({ access_token: expiringIn(3600), refresh_token: "ref" });
    vi.stubGlobal("fetch", vi.fn(async () => deviceCodeResponse()));
    await startCodexLogin();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexLogout()).resolves.toMatchObject({ signedIn: false, pending: false });
    expect(await db.select().from(codexCredentials)).toHaveLength(0);
    expect(await db.select().from(codexLoginAttempts)).toHaveLength(0);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://auth.openai.com/oauth/revoke"
    );
  });
});

describe("codexAuthStatus", () => {
  it("reports pending while an attempt is outstanding", async () => {
    await expect(codexAuthStatus()).resolves.toMatchObject({ signedIn: false, pending: false });
    vi.stubGlobal("fetch", vi.fn(async () => deviceCodeResponse()));
    await startCodexLogin();
    await expect(codexAuthStatus()).resolves.toMatchObject({ signedIn: false, pending: true });
  });
});
