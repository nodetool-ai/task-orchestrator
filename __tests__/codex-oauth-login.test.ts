import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  extractAccountId,
  generatePkce,
  generateState,
  loginWithChatGPT,
  StateMismatchError,
  TokenExchangeError,
  writeCodexAuthFile,
} from "../lib/codex-oauth-login";

function tempCodexHome() {
  return mkdtempSync(join(tmpdir(), "task-orch-codex-login-"));
}

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
  it("assembles the authorize URL with S256 PKCE and the fixed redirect", () => {
    const url = new URL(buildAuthorizationUrl({ challenge: "chal", state: "st8" }));
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
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
    expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
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

describe("writeCodexAuthFile", () => {
  it("writes the resolver-compatible auth.json shape", () => {
    const dir = tempCodexHome();
    try {
      const path = writeCodexAuthFile(
        { access_token: "acc", refresh_token: "ref", id_token: "idt" },
        "acct-1",
        { CODEX_HOME: dir }
      );
      expect(path).toBe(join(dir, "auth.json"));
      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.OPENAI_API_KEY).toBeNull();
      expect(written.tokens.access_token).toBe("acc");
      expect(written.tokens.refresh_token).toBe("ref");
      expect(written.tokens.account_id).toBe("acct-1");
      expect(written.last_refresh).toEqual(expect.any(String));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loginWithChatGPT (end to end over the loopback listener)", () => {
  // Only the OpenAI token endpoint is mocked; requests to the local loopback
  // listener (the forged browser callback) go through the real fetch so the
  // bound server actually receives them.
  function stubTokenEndpoint(response: () => unknown) {
    const realFetch = globalThis.fetch.bind(globalThis);
    const tokenMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
      ok: true,
      json: async () => response(),
    }));
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/oauth/token")) return tokenMock(input, init);
      return realFetch(input as string, init);
    });
    return tokenMock;
  }

  it("drives PKCE → browser → callback → token exchange → persisted auth.json", async () => {
    const dir = tempCodexHome();
    const idToken = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-e2e" },
    });
    const tokenMock = stubTokenEndpoint(() => ({
      access_token: "acc-e2e",
      refresh_token: "ref-e2e",
      id_token: idToken,
    }));

    try {
      // The injected "browser" is the redirect: it reads state off the auth URL
      // and hits the real loopback listener the flow just bound.
      const openBrowser = async (url: string) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://localhost:1455/auth/callback?code=auth-code&state=${state}`);
      };

      const result = await loginWithChatGPT({
        env: { CODEX_HOME: dir },
        openBrowser,
        timeoutMs: 8_000,
      });

      expect(result.accessToken).toBe("acc-e2e");
      expect(result.accountId).toBe("acct-e2e");
      expect(result.authPath).toBe(join(dir, "auth.json"));
      const written = JSON.parse(readFileSync(result.authPath, "utf8"));
      expect(written.tokens.access_token).toBe("acc-e2e");

      // The token exchange must have used the code the callback delivered.
      const [, init] = tokenMock.mock.calls[0] as unknown as [unknown, RequestInit];
      const body = new URLSearchParams(init.body as string);
      expect(body.get("code")).toBe("auth-code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects with StateMismatchError when the callback state is wrong", async () => {
    const dir = tempCodexHome();
    const tokenMock = stubTokenEndpoint(() => {
      throw new Error("token exchange must not run on a state mismatch");
    });

    try {
      const openBrowser = async () => {
        await fetch("http://localhost:1455/auth/callback?code=auth-code&state=WRONG");
      };
      await expect(
        loginWithChatGPT({ env: { CODEX_HOME: dir }, openBrowser, timeoutMs: 8_000 })
      ).rejects.toBeInstanceOf(StateMismatchError);
      expect(tokenMock).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
