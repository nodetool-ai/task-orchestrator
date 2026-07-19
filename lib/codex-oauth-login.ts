// lib/codex-oauth-login.ts
//
// "Login with ChatGPT" (Codex OAuth 2.0 + PKCE) via OpenAI's DEVICE AUTH
// redirect. This is the counterpart to codex-oauth-token.ts: that module *reads
// and refreshes* a stored token, this one *obtains* one without the external
// OpenAI Codex CLI being installed.
//
// Why device auth rather than the loopback flow the Codex CLI uses by default:
// the public client's loopback redirect is http://localhost:1455, which is a
// listener on the machine running the *browser*. For a hosted control plane
// (Fly) the browser and the server are different machines, so a server-bound
// loopback listener never sees the redirect. The device redirect
// https://auth.openai.com/deviceauth/callback is hosted by OpenAI: it displays
// the authorization code to the user, who pastes it back into the UI (or the
// CLI). Same public client, same PKCE, same token endpoint — the only change is
// which redirect_uri is used, and that the code arrives by copy/paste instead
// of over a socket.
//
// This module is deliberately pure: it builds URLs and exchanges codes. Storing
// what comes back is codex-oauth-store.ts's job.
import { createHash, randomBytes } from "node:crypto";
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL } from "./codex-oauth-token";

const CODEX_OAUTH_AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_REVOCATION_URL = "https://auth.openai.com/oauth/revoke";
const CODEX_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** OpenAI-hosted callback that renders the authorization code for the user to copy. */
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";

// Stable string codes so a UI can tell "needs re-login" apart from a transient
// network failure without matching on message text.
export class CodexLoginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexLoginError";
    this.code = code;
  }
}

export class StateMismatchError extends CodexLoginError {
  constructor() {
    super("STATE_MISMATCH", "OAuth state did not match; possible CSRF — aborting login.");
    this.name = "StateMismatchError";
  }
}

export class TokenExchangeError extends CodexLoginError {
  constructor(message: string) {
    super("TOKEN_EXCHANGE_FAILED", message);
    this.name = "TokenExchangeError";
  }
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** code_verifier (random) + code_challenge = base64url(SHA256(verifier)). */
export function generatePkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Random, opaque CSRF token echoed back on the callback. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export interface AuthorizationUrlParams {
  challenge: string;
  state: string;
  clientId?: string;
  redirectUri?: string;
  scopes?: readonly string[];
}

export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(CODEX_OAUTH_AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId ?? CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", params.redirectUri ?? CODEX_DEVICE_REDIRECT_URI);
  url.searchParams.set("scope", (params.scopes ?? CODEX_OAUTH_SCOPES).join(" "));
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

/** POST the authorization code to the token endpoint (grant_type=authorization_code). */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = CODEX_DEVICE_REDIRECT_URI
): Promise<CodexTokens> {
  let res: Response;
  try {
    res = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: CODEX_OAUTH_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    });
  } catch (e) {
    throw new TokenExchangeError(
      `Token request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new TokenExchangeError(
      `Token endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { access_token?: unknown; refresh_token?: unknown; id_token?: unknown }
    | null;
  if (!body || typeof body.access_token !== "string" || !body.access_token.trim()) {
    throw new TokenExchangeError("Token endpoint response had no access_token.");
  }
  return {
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token.trim()
        ? body.refresh_token
        : undefined,
    id_token:
      typeof body.id_token === "string" && body.id_token.trim() ? body.id_token : undefined,
  };
}

/** Best-effort revocation (grant_type-less POST to the revoke endpoint). */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(CODEX_OAUTH_REVOCATION_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CODEX_OAUTH_CLIENT_ID, token }).toString(),
    });
  } catch {
    // Revocation is best-effort; a network failure must not block logout, which
    // still clears the stored credential.
  }
}

/**
 * The ChatGPT account id lives under the OpenAI auth claim namespace of the
 * issued JWT. We decode (never verify — it is the token we were just handed)
 * and fall back to the OIDC subject if the account claim is absent.
 */
export function extractAccountId(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      ["https://api.openai.com/auth"]?: { chatgpt_account_id?: unknown };
    };
    const authClaim = claims["https://api.openai.com/auth"];
    const accountId = authClaim?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) return accountId;
    if (typeof claims.sub === "string" && claims.sub.trim()) return claims.sub;
  } catch {
    return undefined;
  }
  return undefined;
}

export interface ParsedCallback {
  code: string;
  state?: string;
  error?: string;
}

/**
 * Accept whatever the user pasted. OpenAI's device callback page shows a bare
 * `ac_…` code, but the address bar holds the full redirect URL — users paste
 * either, so parse both. A full URL also carries `state`, which lets us verify
 * CSRF; a bare code cannot, and the caller falls back to the single in-flight
 * attempt in that case.
 */
export function parseDeviceCallbackInput(input: string): ParsedCallback {
  const trimmed = input.trim();
  if (!trimmed) throw new CodexLoginError("NO_CODE", "Paste the code from the ChatGPT page.");

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new CodexLoginError("BAD_CALLBACK", "That doesn't look like a valid callback URL.");
    }
    const error = url.searchParams.get("error") ?? undefined;
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? undefined;
    if (error) {
      throw new CodexLoginError("AUTHORIZATION_DENIED", `Authorization error: ${error}`);
    }
    if (!code) {
      throw new CodexLoginError("NO_CODE", "That URL carried no authorization code.");
    }
    return { code, state };
  }

  // A bare code, possibly with stray whitespace from the copy.
  return { code: trimmed.replace(/\s+/g, "") };
}
