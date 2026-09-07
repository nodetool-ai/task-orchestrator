// lib/codex-oauth-login.ts
//
// "Login with ChatGPT" using OpenAI's device-code protocol. The server requests
// a short user code, the browser authorizes it at OpenAI, and the control plane
// polls for the resulting authorization code. No loopback listener or pasted
// callback is required, so this works when the browser and server are on
// different machines.
import { CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_TOKEN_URL } from "./codex-oauth-token";

const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_DEVICE_USER_CODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const CODEX_OAUTH_REVOCATION_URL = `${CODEX_AUTH_BASE_URL}/oauth/revoke`;

export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_AUTH_BASE_URL}/codex/device`;

// Stable string codes let the UI distinguish actionable login failures from
// transient server failures without matching message text.
export class CodexLoginError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexLoginError";
    this.code = code;
  }
}

export class TokenExchangeError extends CodexLoginError {
  constructor(message: string) {
    super("TOKEN_EXCHANGE_FAILED", message);
    this.name = "TokenExchangeError";
  }
}

export interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export interface CodexDeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
}

/** Request the one-time code that the user enters on OpenAI's device page. */
export async function requestDeviceCode(): Promise<CodexDeviceCode> {
  let res: Response;
  try {
    res = await fetch(CODEX_DEVICE_USER_CODE_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    });
  } catch (e) {
    throw new CodexLoginError(
      "DEVICE_CODE_REQUEST_FAILED",
      `Device-code request failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new CodexLoginError(
      "DEVICE_CODE_REQUEST_FAILED",
      `Device-code endpoint returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown }
    | null;
  const deviceAuthId = body?.device_auth_id;
  const userCode = body?.user_code ?? body?.usercode;
  const interval = Number(body?.interval);
  if (
    typeof deviceAuthId !== "string" ||
    !deviceAuthId.trim() ||
    typeof userCode !== "string" ||
    !userCode.trim()
  ) {
    throw new CodexLoginError(
      "DEVICE_CODE_REQUEST_FAILED",
      "Device-code endpoint response was missing the device or user code."
    );
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    intervalSeconds: Number.isFinite(interval) && interval >= 1 ? interval : 5,
  };
}

export type DeviceAuthorizationPoll =
  | { status: "pending" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string };

/** Poll once. OpenAI uses 403/404 while the user has not authorized the code. */
export async function pollDeviceAuthorization(
  deviceAuthId: string,
  userCode: string
): Promise<DeviceAuthorizationPoll> {
  let res: Response;
  try {
    res = await fetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });
  } catch (e) {
    throw new CodexLoginError(
      "DEVICE_POLL_FAILED",
      `Device authorization check failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new CodexLoginError(
      "DEVICE_AUTHORIZATION_FAILED",
      `Device authorization failed with ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { authorization_code?: unknown; code_verifier?: unknown }
    | null;
  if (
    typeof body?.authorization_code !== "string" ||
    !body.authorization_code.trim() ||
    typeof body.code_verifier !== "string" ||
    !body.code_verifier.trim()
  ) {
    throw new CodexLoginError(
      "DEVICE_AUTHORIZATION_FAILED",
      "Device authorization response was missing the authorization code or PKCE verifier."
    );
  }
  return {
    status: "authorized",
    authorizationCode: body.authorization_code,
    codeVerifier: body.code_verifier,
  };
}

/** Exchange OpenAI's authorization code for the token set used by Codex. */
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

/** Best-effort revocation; logout still clears the stored credential on failure. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(CODEX_OAUTH_REVOCATION_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CODEX_OAUTH_CLIENT_ID, token }).toString(),
    });
  } catch {
    // Best effort.
  }
}

/** Extract the ChatGPT account id from a token we just received. */
export function extractAccountId(jwt: string | undefined): string | undefined {
  if (!jwt) return undefined;
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      ["https://api.openai.com/auth"]?: { chatgpt_account_id?: unknown };
    };
    const accountId = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) return accountId;
    if (typeof claims.sub === "string" && claims.sub.trim()) return claims.sub;
  } catch {
    return undefined;
  }
  return undefined;
}
