// lib/codex-oauth-token.ts
//
// Reads and refreshes the Codex OAuth bearer. Two sources, in order:
//
//   1. CODEX_ACCESS_TOKEN — an explicit override, and the ONLY source a worker
//      has. Workers (Fly Machines, Box sandboxes) run the agent turn in-process
//      with no DB connection, so the control plane resolves the token at
//      dispatch time and forwards it as env (lib/agent-backend/provider-env.ts).
//   2. The codex_credentials row, written by the device-code login in Settings.
//      Refreshing writes the new pair back so the next dispatch forwards a live
//      token.
//
// The DB read is behind a dynamic import on purpose: this module is pulled into
// worker code paths where `@/db` has no DATABASE_URL and importing it eagerly
// would throw at module load.
export const CODEX_ACCESS_TOKEN_ENV = "CODEX_ACCESS_TOKEN";

// OpenAI's public Codex CLI client (public/native app, no client secret). The
// login flow in codex-oauth-login.ts and the just-in-time refresh below share
// these so there is a single source of truth for the client identity.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS = 60_000;

type EnvLike = Record<string, string | undefined>;

function explicitToken(env: EnvLike): string | undefined {
  const token = env[CODEX_ACCESS_TOKEN_ENV];
  return token && token.trim() ? token : undefined;
}

/** The `exp` claim of a JWT as a Date, or null if it has none / isn't a JWT. */
export function jwtExpiry(token: string): Date | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? new Date(json.exp * 1000) : null;
  } catch {
    return null;
  }
}

/** True when `expiresAt` is within the refresh skew (or already past). */
export function isNearlyExpired(expiresAt: Date | null | undefined): boolean {
  return expiresAt != null && Date.now() >= expiresAt.getTime() - EXPIRY_SKEW_MS;
}

export interface RefreshedTokens {
  access_token: string;
  refresh_token?: string;
}

/** Exchange a refresh token for a new access token. Returns null on any failure. */
export async function refreshCodexTokens(refreshToken: string): Promise<RefreshedTokens | null> {
  let res: Response;
  try {
    res = await fetch(CODEX_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
  if (!body || typeof body.access_token !== "string" || !body.access_token.trim()) return null;
  return {
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token.trim()
        ? body.refresh_token
        : undefined,
  };
}

/**
 * Resolve the Codex bearer, refreshing the stored credential if it is at or
 * near expiry. Returns undefined when there is no credential at all — callers
 * treat that as "Codex models unavailable", not as an error.
 */
export async function resolveCodexAccessToken(
  env: EnvLike = process.env
): Promise<string | undefined> {
  const explicit = explicitToken(env);
  if (explicit) return explicit;

  try {
    const store = await import("./codex-oauth-store");
    return await store.resolveStoredAccessToken();
  } catch {
    // No DB in this process (worker: no DATABASE_URL, or the table doesn't
    // exist yet pre-migration). Env was the only source available.
    return undefined;
  }
}
