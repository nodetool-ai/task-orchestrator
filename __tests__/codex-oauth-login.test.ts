import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URL,
  CodexLoginError,
  exchangeAuthorizationCode,
  extractAccountId,
  pollDeviceAuthorization,
  requestDeviceCode,
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

describe("requestDeviceCode", () => {
  it("requests and returns an OpenAI device code", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        device_auth_id: "device-123",
        user_code: "ABCD-EFGH",
        interval: "3",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestDeviceCode()).resolves.toEqual({
      deviceAuthId: "device-123",
      userCode: "ABCD-EFGH",
      verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
      intervalSeconds: 3,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
    expect(JSON.parse(init.body as string)).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  it("rejects malformed and failed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await expect(requestDeviceCode()).rejects.toBeInstanceOf(CodexLoginError);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "unavailable" }))
    );
    await expect(requestDeviceCode()).rejects.toBeInstanceOf(CodexLoginError);
  });
});

describe("pollDeviceAuthorization", () => {
  it.each([403, 404])("treats HTTP %s as pending", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status })));
    await expect(pollDeviceAuthorization("device", "CODE")).resolves.toEqual({
      status: "pending",
    });
  });

  it("returns the authorization code and server-issued PKCE verifier", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        authorization_code: "auth-code",
        code_challenge: "challenge",
        code_verifier: "verifier",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollDeviceAuthorization("device", "CODE")).resolves.toEqual({
      status: "authorized",
      authorizationCode: "auth-code",
      codeVerifier: "verifier",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/api/accounts/deviceauth/token");
    expect(JSON.parse(init.body as string)).toEqual({
      device_auth_id: "device",
      user_code: "CODE",
    });
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

  it("falls back to the OIDC subject and tolerates malformed tokens", () => {
    expect(extractAccountId(fakeJwt({ sub: "user-sub" }))).toBe("user-sub");
    expect(extractAccountId("not-a-jwt")).toBeUndefined();
  });
});

describe("exchangeAuthorizationCode", () => {
  it("POSTs the code and returns the tokens", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: "acc", refresh_token: "ref", id_token: "idt" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeAuthorizationCode("the-code", "the-verifier")).resolves.toEqual({
      access_token: "acc",
      refresh_token: "ref",
      id_token: "idt",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBe("the-verifier");
    expect(body.get("redirect_uri")).toBe(CODEX_DEVICE_REDIRECT_URI);
  });

  it("throws when the token response fails or has no access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad_grant" }))
    );
    await expect(exchangeAuthorizationCode("c", "v")).rejects.toBeInstanceOf(TokenExchangeError);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await expect(exchangeAuthorizationCode("c", "v")).rejects.toBeInstanceOf(TokenExchangeError);
  });
});
