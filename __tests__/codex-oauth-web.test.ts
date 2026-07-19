import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginOptions, LoginResult } from "../lib/codex-oauth-login";

// Control loginWithChatGPT so the web orchestration is tested without binding
// the real loopback port. Keep every other export (error classes, extractAccountId,
// revokeToken) real.
const loginMock = vi.fn<(opts: LoginOptions) => Promise<LoginResult>>();
vi.mock("../lib/codex-oauth-login", async (importActual) => {
  const actual = await importActual<typeof import("../lib/codex-oauth-login")>();
  return { ...actual, loginWithChatGPT: (opts: LoginOptions) => loginMock(opts) };
});

function fakeJwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

const tick = () => new Promise((r) => setImmediate(r));

let dir: string;
let web: typeof import("../lib/codex-oauth-web");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "task-orch-codex-web-"));
  process.env.CODEX_HOME = dir;
  loginMock.mockReset();
  vi.resetModules();
  web = await import("../lib/codex-oauth-web");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
});

describe("codexAuthStatus", () => {
  it("reports not signed in when no auth file exists", () => {
    const status = web.codexAuthStatus();
    expect(status.signedIn).toBe(false);
    expect(status.pending).toBe(false);
    expect(status.authPath).toBe(join(dir, "auth.json"));
  });

  it("reports signed in and extracts the account id from the stored token", () => {
    const token = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: token } }));
    const status = web.codexAuthStatus();
    expect(status.signedIn).toBe(true);
    expect(status.accountId).toBe("acct-9");
  });
});

describe("startCodexWebLogin", () => {
  it("returns the authorization URL and is single-flight while in progress", async () => {
    loginMock.mockImplementation((opts) => {
      opts.onAuthorizationUrl?.("https://auth.openai.com/oauth/authorize?state=abc");
      return new Promise<LoginResult>(() => {}); // never resolves — stays in flight
    });

    const first = await web.startCodexWebLogin();
    expect(first.authorizationUrl).toContain("state=abc");
    expect(web.codexAuthStatus().pending).toBe(true);

    const second = await web.startCodexWebLogin();
    expect(second.authorizationUrl).toBe(first.authorizationUrl);
    // Single-flight: the underlying login is only invoked once.
    expect(loginMock).toHaveBeenCalledTimes(1);
  });

  it("captures a login failure so status surfaces it and clears the in-flight state", async () => {
    const { StateMismatchError } = await import("../lib/codex-oauth-login");
    let reject!: (e: unknown) => void;
    loginMock.mockImplementation((opts) => {
      opts.onAuthorizationUrl?.("https://auth.openai.com/oauth/authorize?state=xyz");
      return new Promise<LoginResult>((_res, rej) => {
        reject = rej;
      });
    });

    await web.startCodexWebLogin();
    reject(new StateMismatchError());
    await tick();

    const status = web.codexAuthStatus();
    expect(status.pending).toBe(false);
    expect(status.error?.code).toBe("STATE_MISMATCH");
  });

  it("propagates a start failure that happens before the URL is produced", async () => {
    loginMock.mockImplementation(() => Promise.reject(new Error("Port 1455 is already in use.")));
    await expect(web.startCodexWebLogin()).rejects.toThrow(/1455/);
    expect(web.codexAuthStatus().pending).toBe(false);
  });
});

describe("codexWebLogout", () => {
  it("removes the local auth file", async () => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "t" } }));
    expect(web.codexAuthStatus().signedIn).toBe(true);
    await web.codexWebLogout();
    expect(web.codexAuthStatus().signedIn).toBe(false);
  });
});
