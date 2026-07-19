// lib/codex-oauth-login.ts
//
// Interactive "Login with ChatGPT" (Codex OAuth 2.0 + PKCE) for the
// orchestrator. This is the counterpart to codex-oauth-token.ts: that module
// *reads and refreshes* an existing token, this one *obtains* one without the
// external OpenAI Codex CLI being installed.
//
// The flow is the desktop/CLI single-user pattern from the porting guide: we
// bind the loopback listener locally, open the user's browser to OpenAI's
// authorize endpoint, wait for the redirect back to
// http://localhost:1455/auth/callback, exchange the code for tokens, and write
// them to CODEX_HOME/auth.json in the exact shape resolveCodexAccessToken()
// (and the real Codex CLI) reads.
//
// The public client's only registered redirect is
// http://localhost:1455/auth/callback, so the loopback listener MUST bind that
// exact port and path — it is not configurable.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_TOKEN_URL,
  codexAuthPath,
} from "./codex-oauth-token";

const CODEX_OAUTH_AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";
const CODEX_OAUTH_REVOCATION_URL = "https://auth.openai.com/oauth/revoke";
const CODEX_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_PATH = "/auth/callback";
const CODEX_REDIRECT_URI = `http://localhost:${CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

type EnvLike = Record<string, string | undefined>;

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

export class CallbackServerError extends CodexLoginError {
  constructor(message: string) {
    super("CALLBACK_SERVER_FAILED", message);
    this.name = "CallbackServerError";
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
  url.searchParams.set("redirect_uri", params.redirectUri ?? CODEX_REDIRECT_URI);
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
  redirectUri: string = CODEX_REDIRECT_URI
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
    // still clears the local credential.
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

/**
 * Persist the tokens to CODEX_HOME/auth.json in the shape the resolver and the
 * real Codex CLI read: an OPENAI_API_KEY slot (null for OAuth logins), a nested
 * `tokens` object, and a last_refresh timestamp. Written 0600.
 */
export function writeCodexAuthFile(
  tokens: CodexTokens,
  accountId: string | undefined,
  env: EnvLike = process.env
): string {
  const file = codexAuthPath(env);
  mkdirSync(path.dirname(file), { recursive: true });
  const auth = {
    OPENAI_API_KEY: null as string | null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  return file;
}

interface CallbackResult {
  code: string;
  state: string;
}

/**
 * Single-shot loopback listener on port 1455. Resolves once the browser hits
 * /auth/callback with a code+state. Validates the state BEFORE trusting the
 * code (CSRF-safe ordering) — a mismatch rejects with StateMismatchError.
 */
function waitForCallback(expectedState: string, signal?: AbortSignal): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", CODEX_REDIRECT_URI);
      if (requestUrl.pathname !== CODEX_CALLBACK_PATH) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      const error = requestUrl.searchParams.get("error");
      const state = requestUrl.searchParams.get("state") ?? "";
      const code = requestUrl.searchParams.get("code") ?? "";

      // Validate state before trusting the code.
      if (state !== expectedState) {
        respond(res, 400, "Login failed: state mismatch. You can close this window.");
        finish(() => reject(new StateMismatchError()));
        return;
      }
      if (error) {
        respond(res, 400, `Login failed: ${error}. You can close this window.`);
        finish(() => reject(new CodexLoginError("AUTHORIZATION_DENIED", `Authorization error: ${error}`)));
        return;
      }
      if (!code) {
        respond(res, 400, "Login failed: no authorization code. You can close this window.");
        finish(() => reject(new CodexLoginError("NO_CODE", "Callback carried no authorization code.")));
        return;
      }
      respond(res, 200, "Login complete — you can close this window and return to the terminal.");
      finish(() => resolve({ code, state }));
    });

    let settled = false;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      server.close();
      act();
    };
    const onAbort = () =>
      finish(() => reject(new CodexLoginError("ABORTED", "Login aborted.")));

    if (signal) {
      if (signal.aborted) {
        reject(new CodexLoginError("ABORTED", "Login aborted."));
        return;
      }
      signal.addEventListener("abort", onAbort);
    }

    server.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "EADDRINUSE"
          ? `Port ${CODEX_CALLBACK_PORT} is already in use. Close whatever is bound to it (another Codex login?) and retry.`
          : `Callback server error: ${err.message}`;
      finish(() => reject(new CallbackServerError(message)));
    });
    server.listen(CODEX_CALLBACK_PORT, "127.0.0.1");
  });
}

function respond(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Codex login</title></head>` +
      `<body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">` +
      `<p>${body}</p></body></html>`
  );
}

/** Open the system browser to `url` (platform default handler). Best-effort. */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* Falls back to the printed URL; see loginWithChatGPT's onAuthorizationUrl. */
    });
    child.unref();
  } catch {
    // No browser launcher available; the caller prints the URL to open manually.
  }
}

export interface LoginOptions {
  env?: EnvLike;
  /** Override the browser launcher (tests, headless hosts). */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Called with the authorization URL so a CLI can print it as a fallback. */
  onAuthorizationUrl?: (url: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  authPath: string;
}

/**
 * Run the full interactive login: PKCE, loopback callback, browser, token
 * exchange, and persistence. Resolves once auth.json is written.
 */
export async function loginWithChatGPT(options: LoginOptions = {}): Promise<LoginResult> {
  const env = options.env ?? process.env;
  const launch = options.openBrowser ?? openBrowser;
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const authorizationUrl = buildAuthorizationUrl({ challenge, state });

  const abort = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const timer = setTimeout(
    () => abort.abort(),
    timeoutMs
  );
  const onExternalAbort = () => abort.abort();
  if (options.signal) {
    if (options.signal.aborted) abort.abort();
    else options.signal.addEventListener("abort", onExternalAbort);
  }

  try {
    const callbackPromise = waitForCallback(state, abort.signal);
    // The callback can settle (e.g. a state mismatch) before `launch` returns,
    // which would flag an unhandled rejection before the await below attaches a
    // handler. This early no-op catch adopts it; the real await still throws.
    callbackPromise.catch(() => {});
    options.onAuthorizationUrl?.(authorizationUrl);
    await launch(authorizationUrl);
    const { code } = await callbackPromise;
    clearTimeout(timer);

    const tokens = await exchangeAuthorizationCode(code, verifier);
    const accountId = extractAccountId(tokens.id_token) ?? extractAccountId(tokens.access_token);
    const authPath = writeCodexAuthFile(tokens, accountId, env);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accountId,
      authPath,
    };
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onExternalAbort);
  }
}

export const __testables = {
  CODEX_REDIRECT_URI,
  CODEX_CALLBACK_PORT,
  CODEX_CALLBACK_PATH,
  CODEX_OAUTH_AUTHORIZATION_URL,
  CODEX_OAUTH_REVOCATION_URL,
  CODEX_OAUTH_SCOPES,
  defaultCodexHome: () => path.join(homedir(), ".codex"),
};
