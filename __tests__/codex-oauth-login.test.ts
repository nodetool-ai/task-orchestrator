import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  CODEX_DEVICE_REDIRECT_URI,
  CodexLoginError,
  exchangeAuthorizationCode,
  extractAccountId,
  generatePkce,
  generateState,
  parseDeviceCallbackInput,
  TokenExchangeError,
} from "../lib/codex-oauth-login";

function fakeJwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PKCE + state", () => {
  it("derives the challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("produces distinct random state values", () => {
    expect(generateState()).not.toBe(generateState());
  });
});

describe("buildAuthorizationUrl", () => {
  it("assembles the authorize URL with S256 PKCE and the device redirect", () => {
    const url = new URL(buildAuthorizationUrl({ challenge: "chal", state: "st8" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback"
    );
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st8");
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access");
  });
});

describe("extractAccountId", () => {
  it("prefers the ChatGPT account id claim", () => {
    const jwt = fakeJwt({
      sub: "user-sub",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    });
    expect(extractAccountId(jwt)).toBe("acct-123");
  });

  it("falls back to the OIDC subject", () => {
    expect(extractAccountId(fakeJwt({ sub: "user-sub" }))).toBe("user-sub");
  });

  it("returns undefined for a malformed token", () => {
    expect(extractAccountId("not-a-jwt")).toBeUndefined();
    expect(extractAccountId(undefined)).toBeUndefined();
  });
});

describe("exchangeAuthorizationCode", () => {
  it("POSTs the code and returns the tokens", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        access_token: "acc",
        refresh_token: "ref",
        id_token: "idt",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangeAuthorizationCode("the-code", "the-verifier");
    expect(tokens).toEqual({ access_token: "acc", refresh_token: "ref", id_token: "idt" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT_URI);
  });

  it("throws TokenExchangeError on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad_grant" }))
    );
    await expect(exchangeAuthorizationCode("c", "v")).rejects.toBeInstanceOf(TokenExchangeError);
  });

  it("throws TokenExchangeError when access_token is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await expect(exchangeAuthorizationCode("c", "v")).rejects.toBeInstanceOf(TokenExchangeError);
  });
});

describe("parseDeviceCallbackInput", () => {
  it("accepts a bare code and reports no state", () => {
    expect(parseDeviceCallbackInput("  ac_abc123  ")).toEqual({ code: "ac_abc123" });
  });

  it("strips whitespace a copy/paste may have wrapped into the code", () => {
    expect(parseDeviceCallbackInput("ac_abc\n123").code).toBe("ac_abc123");
  });

  it("pulls code and state out of the full callback URL", () => {
    const parsed = parseDeviceCallbackInput(
      `${CODEX_DEVICE_REDIRECT_URI}?code=ac_xyz&scope=openid+profile&state=st8`
    );
    expect(parsed).toEqual({ code: "ac_xyz", state: "st8" });
  });

  it("surfaces an error carried by the callback URL", () => {
    expect(() =>
      parseDeviceCallbackInput(`${CODEX_DEVICE_REDIRECT_URI}?error=access_denied&state=st8`)
    ).toThrow(CodexLoginError);
  });

  it("rejects an empty paste and a URL with no code", () => {
    expect(() => parseDeviceCallbackInput("   ")).toThrow(CodexLoginError);
    expect(() => parseDeviceCallbackInput(`${CODEX_DEVICE_REDIRECT_URI}?state=st8`)).toThrow(
      CodexLoginError
    );
  });
});
