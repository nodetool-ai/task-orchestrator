import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CODEX_ACCESS_TOKEN_ENV = "CODEX_ACCESS_TOKEN";

// OpenAI's public Codex CLI client (public/native app, no client secret). The
// login flow in codex-oauth-login.ts and the just-in-time refresh below share
// these so there is a single source of truth for the client identity.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const EXPIRY_SKEW_MS = 60_000;

type EnvLike = Record<string, string | undefined>;

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function codexHome(env: EnvLike = process.env): string {
  return env.CODEX_HOME || path.join(homedir(), ".codex");
}

export function codexAuthPath(env: EnvLike = process.env): string {
  return path.join(codexHome(env), "auth.json");
}

function explicitToken(env: EnvLike): string | undefined {
  const token = env[CODEX_ACCESS_TOKEN_ENV];
  return token && token.trim() ? token : undefined;
}

function readAuthFile(env: EnvLike): { path: string; auth: CodexAuthFile } | null {
  const file = codexAuthPath(env);
  if (!existsSync(file)) return null;
  try {
    return { path: file, auth: JSON.parse(readFileSync(file, "utf8")) as CodexAuthFile };
  } catch {
    return null;
  }
}

function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isNearlyExpired(token: string): boolean {
  const expiry = jwtExpiryMs(token);
  return expiry != null && Date.now() >= expiry - EXPIRY_SKEW_MS;
}

/**
 * Resolve the Codex OAuth bearer. CODEX_ACCESS_TOKEN is only an explicit
 * override; the normal local path is the Codex CLI/app login stored under
 * CODEX_HOME/auth.json.
 */
export function resolveCodexAccessTokenSync(env: EnvLike = process.env): string | undefined {
  const explicit = explicitToken(env);
  if (explicit) return explicit;

  const loaded = readAuthFile(env);
  if (!loaded) return undefined;

  const token = loaded.auth.tokens?.access_token;
  return typeof token === "string" && token.trim() ? token : undefined;
}

export async function resolveCodexAccessToken(env: EnvLike = process.env): Promise<string | undefined> {
  const explicit = explicitToken(env);
  if (explicit) return explicit;

  const loaded = readAuthFile(env);
  if (!loaded) return undefined;

  const token = loaded.auth.tokens?.access_token;
  if (typeof token !== "string" || !token.trim()) return undefined;
  if (!isNearlyExpired(token)) return token;

  const refreshToken = loaded.auth.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || !refreshToken.trim()) return token;

  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
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
  if (!res.ok) return token;

  const body = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token.trim()) return token;

  loaded.auth.tokens = {
    ...loaded.auth.tokens,
    access_token: body.access_token,
    refresh_token:
      typeof body.refresh_token === "string" && body.refresh_token.trim()
        ? body.refresh_token
        : refreshToken,
  };
  loaded.auth.last_refresh = new Date().toISOString();
  try {
    writeFileSync(loaded.path, `${JSON.stringify(loaded.auth, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A refreshed in-memory token is still useful even if the host file is read-only.
  }
  return body.access_token;
}
