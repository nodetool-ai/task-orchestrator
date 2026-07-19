// lib/codex-oauth-web.ts
//
// Server-side orchestration for the "Sign in with ChatGPT" button in the UI.
//
// The public Codex client's redirect is fixed to http://localhost:1455, so a
// normal server-side OAuth redirect can't work across machines. The web
// pattern (per the porting guide) is: the SERVER binds the loopback listener
// and produces the authorization URL, the FRONTEND opens that URL in the
// user's browser, the exchange completes in the background here, and the
// frontend polls status until the token lands. This assumes the server and the
// user's browser share a machine — correct for the self-hosted/local
// orchestrator, not for a hosted SaaS with remote users.
//
// Login is single-flight: port 1455 can only be bound once, so a second start
// while one is in flight returns the same authorization URL. State lives in
// module scope, which is process-local — fine for the single-process
// self-hosted server this UI targets.
import { rmSync } from "node:fs";
import {
  CodexLoginError,
  extractAccountId,
  loginWithChatGPT,
  revokeToken,
  type LoginResult,
} from "./codex-oauth-login";
import { codexAuthPath, resolveCodexAccessTokenSync } from "./codex-oauth-token";

interface Inflight {
  authorizationUrl: string;
  promise: Promise<LoginResult>;
  startedAt: number;
}

let inflight: Inflight | null = null;
let lastError: { code: string; message: string } | null = null;

export interface CodexAuthStatus {
  signedIn: boolean;
  pending: boolean;
  accountId?: string;
  authPath: string;
  /** Present while a login is in flight, so the UI can offer a manual-open link. */
  authorizationUrl?: string;
  error?: { code: string; message: string };
}

/**
 * Start (or rejoin) the interactive login. Returns the authorization URL the
 * frontend should open in the user's browser. The exchange finishes in the
 * background; poll {@link codexAuthStatus} until `signedIn` (or `error`).
 */
export async function startCodexWebLogin(): Promise<{ authorizationUrl: string }> {
  if (inflight) return { authorizationUrl: inflight.authorizationUrl };
  lastError = null;

  let resolveUrl!: (url: string) => void;
  const urlReady = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });

  const promise = loginWithChatGPT({
    // The user's browser opens the URL — the server must not spawn one.
    openBrowser: () => {},
    onAuthorizationUrl: (url) => resolveUrl(url),
  });

  promise
    .then(
      () => {
        lastError = null;
      },
      (err: unknown) => {
        lastError = {
          code: err instanceof CodexLoginError ? err.code : "LOGIN_FAILED",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    )
    .finally(() => {
      inflight = null;
    });

  // If the flow fails before the URL is produced (e.g. port 1455 is already
  // bound), surface that as the start error instead of hanging on urlReady.
  const authorizationUrl = await Promise.race([
    urlReady,
    promise.then(
      () => {
        throw new Error("Login completed before an authorization URL was produced.");
      },
      (err) => {
        throw err;
      }
    ),
  ]);

  inflight = { authorizationUrl, promise, startedAt: Date.now() };
  return { authorizationUrl };
}

/** Snapshot of the current Codex credential + any in-flight login. */
export function codexAuthStatus(): CodexAuthStatus {
  const token = resolveCodexAccessTokenSync();
  return {
    signedIn: Boolean(token),
    pending: inflight != null,
    accountId: token ? extractAccountId(token) : undefined,
    authPath: codexAuthPath(),
    authorizationUrl: inflight?.authorizationUrl,
    error: lastError ?? undefined,
  };
}

/** Revoke the token (best-effort) and remove the local auth.json. */
export async function codexWebLogout(): Promise<void> {
  const token = resolveCodexAccessTokenSync();
  if (token) await revokeToken(token);
  try {
    rmSync(codexAuthPath(), { force: true });
  } catch {
    // Best-effort: the token is already revoked; a read-only file just stays.
  }
  lastError = null;
}
