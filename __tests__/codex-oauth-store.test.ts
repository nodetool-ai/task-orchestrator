// The DB-backed Codex credential store. This is what replaced ~/.codex/auth.json
// and the CODEX_ACCESS_TOKEN deploy secret: a device-code login in the UI lands
// here, and dispatch reads (and refreshes) it from here.
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
import { CODEX_DEVICE_REDIRECT_URI } from "../lib/codex-oauth-login";

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const expiringIn = (seconds: number) => jwt({ exp: Math.floor(Date.now() / 1000) + seconds });

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

    // A second login replaces the row rather than violating the singleton.
    await saveCodexTokens({ access_token: jwt({ sub: "acct-2" }), refresh_token: "ref2" });
    const rows = await db.select().from(codexCredentials);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe("acct-2");
    expect(rows[0].refreshToken).toBe("ref2");
  });
});

describe("startCodexLogin", () => {
  it("returns a device-redirect authorize URL and persists the verifier", async () => {
    const { authorizationUrl, state } = await startCodexLogin();
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT_URI);
    expect(url.searchParams.get("state")).toBe(state);

    const [attempt] = await db.select().from(codexLoginAttempts);
    expect(attempt.state).toBe(state);
    expect(attempt.verifier).toEqual(expect.any(String));
  });
});

describe("completeCodexLogin", () => {
  function stubExchange() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: expiringIn(3600), refresh_token: "ref" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("redeems a pasted callback URL, matching it to the attempt by state", async () => {
    const { state } = await startCodexLogin();
    const fetchMock = stubExchange();

    const status = await completeCodexLogin(
      `${CODEX_DEVICE_REDIRECT_URI}?code=ac_paste&scope=openid&state=${state}`
    );
    expect(status.signedIn).toBe(true);

    const body = new URLSearchParams(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string
    );
    expect(body.get("code")).toBe("ac_paste");
    expect(body.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT_URI);
  });

  it("redeems a bare code against the single outstanding attempt", async () => {
    await startCodexLogin();
    stubExchange();
    await expect(completeCodexLogin("ac_bare")).resolves.toMatchObject({ signedIn: true });
  });

  it("burns the attempt so a replayed paste cannot be redeemed twice", async () => {
    const { state } = await startCodexLogin();
    stubExchange();
    const paste = `${CODEX_DEVICE_REDIRECT_URI}?code=ac_once&state=${state}`;

    await completeCodexLogin(paste);
    expect(await db.select().from(codexLoginAttempts)).toHaveLength(0);
    await expect(completeCodexLogin(paste)).rejects.toThrow(/expired or was already used/);
  });

  it("refuses a bare code when more than one login is in flight", async () => {
    await startCodexLogin();
    await startCodexLogin();
    await expect(completeCodexLogin("ac_ambiguous")).rejects.toThrow(/More than one sign-in/);
  });

  it("rejects a state that matches no attempt", async () => {
    await startCodexLogin();
    await expect(
      completeCodexLogin(`${CODEX_DEVICE_REDIRECT_URI}?code=ac_x&state=not-the-state`)
    ).rejects.toThrow(/expired or was already used/);
  });
});

describe("resolveStoredAccessToken", () => {
  it("returns a live token untouched", async () => {
    const access = expiringIn(3600);
    await saveCodexTokens({ access_token: access, refresh_token: "ref" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("should not refresh a live token");
      })
    );
    await expect(resolveStoredAccessToken()).resolves.toBe(access);
  });

  it("refreshes a near-expiry token and writes the rotated pair back", async () => {
    await saveCodexTokens({ access_token: expiringIn(30), refresh_token: "old-ref" });
    const rotated = expiringIn(3600);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: rotated, refresh_token: "new-ref" }),
      }))
    );

    await expect(resolveStoredAccessToken()).resolves.toBe(rotated);
    const [row] = await db.select().from(codexCredentials);
    expect(row.accessToken).toBe(rotated);
    expect(row.refreshToken).toBe("new-ref");
  });

  it("falls back to the stale token when the refresh fails, rather than failing the run", async () => {
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
  it("reports pending while an attempt is outstanding and signed-out with no credential", async () => {
    await expect(codexAuthStatus()).resolves.toMatchObject({ signedIn: false, pending: false });
    await startCodexLogin();
    await expect(codexAuthStatus()).resolves.toMatchObject({ signedIn: false, pending: true });
  });
});
