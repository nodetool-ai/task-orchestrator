// The Codex bearer resolver. Two sources only: the CODEX_ACCESS_TOKEN env
// override (the sole source a worker has — no DB there) and the
// codex_credentials row. ~/.codex/auth.json is deliberately no longer read;
// the DB is the control plane's single source of truth.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNearlyExpired,
  jwtExpiry,
  refreshCodexTokens,
  resolveCodexAccessToken,
} from "../lib/codex-oauth-token";

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("jwtExpiry", () => {
  it("decodes the exp claim to a Date", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(jwtExpiry(fakeJwt(exp))?.getTime()).toBe(exp * 1000);
  });

  it("returns null for a token that isn't a JWT or carries no exp", () => {
    expect(jwtExpiry("not-a-jwt")).toBeNull();
    expect(jwtExpiry(`header.${Buffer.from("{}").toString("base64url")}.sig`)).toBeNull();
  });
});

describe("isNearlyExpired", () => {
  it("is true at or inside the 60s refresh skew, false well before it", () => {
    expect(isNearlyExpired(new Date(Date.now() + 30_000))).toBe(true);
    expect(isNearlyExpired(new Date(Date.now() - 1))).toBe(true);
    expect(isNearlyExpired(new Date(Date.now() + 3_600_000))).toBe(false);
    // No expiry known => never proactively refreshed.
    expect(isNearlyExpired(null)).toBe(false);
  });
});

describe("refreshCodexTokens", () => {
  it("exchanges the refresh token and returns the rotated pair", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCodexTokens("old-refresh")).resolves.toEqual({
      access_token: "new-access",
      refresh_token: "new-refresh",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  it("returns null rather than throwing when the endpoint rejects or the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => "" })));
    await expect(refreshCodexTokens("r")).resolves.toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );
    await expect(refreshCodexTokens("r")).resolves.toBeNull();
  });

  it("keeps the caller's refresh token when the response rotates only the access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ access_token: "new-access" }) }))
    );
    await expect(refreshCodexTokens("old-refresh")).resolves.toEqual({
      access_token: "new-access",
      refresh_token: undefined,
    });
  });
});

describe("resolveCodexAccessToken", () => {
  it("prefers the CODEX_ACCESS_TOKEN override without touching the store", async () => {
    await expect(resolveCodexAccessToken({ CODEX_ACCESS_TOKEN: "from-env" })).resolves.toBe(
      "from-env"
    );
  });

  it("ignores a blank override and falls through to the store", async () => {
    vi.doMock("../lib/codex-oauth-store", () => ({
      resolveStoredAccessToken: async () => "from-db",
    }));
    const { resolveCodexAccessToken: resolve } = await import("../lib/codex-oauth-token");
    await expect(resolve({ CODEX_ACCESS_TOKEN: "   " })).resolves.toBe("from-db");
    vi.doUnmock("../lib/codex-oauth-store");
  });

  it("resolves undefined — not a throw — when the process has no DB", async () => {
    vi.doMock("../lib/codex-oauth-store", () => ({
      resolveStoredAccessToken: async () => {
        throw new Error("DATABASE_URL is not set.");
      },
    }));
    const { resolveCodexAccessToken: resolve } = await import("../lib/codex-oauth-token");
    await expect(resolve({})).resolves.toBeUndefined();
    vi.doUnmock("../lib/codex-oauth-store");
  });
});
