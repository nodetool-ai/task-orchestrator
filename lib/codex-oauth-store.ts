// lib/codex-oauth-store.ts
//
// Persistence + orchestration for the Codex device-code login. Replaces the old
// codex-oauth-web.ts, whose state lived in module scope and whose credential
// lived in ~/.codex/auth.json — neither of which survives a Fly deploy.
//
// Everything here touches the DB, so it is control-plane only. Workers get the
// resolved token through the CODEX_ACCESS_TOKEN env var instead (see
// lib/agent-backend/provider-env.ts).
import { eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { codexCredentials, codexLoginAttempts } from "@/db/schema";
import {
  CodexLoginError,
  extractAccountId,
  exchangeAuthorizationCode,
  pollDeviceAuthorization,
  requestDeviceCode,
  revokeToken,
  type CodexTokens,
} from "./codex-oauth-login";
import { isNearlyExpired, jwtExpiry, refreshCodexTokens } from "./codex-oauth-token";

/** How long a started login stays redeemable before it is swept. */
const ATTEMPT_TTL_MS = 15 * 60_000;

export interface CodexAuthStatus {
  signedIn: boolean;
  /** True while at least one un-expired login attempt is outstanding. */
  pending: boolean;
  accountId?: string;
  expiresAt?: string;
  updatedAt?: string;
}

/** Persist a freshly-issued token set as the singleton credential row. */
export async function saveCodexTokens(tokens: CodexTokens): Promise<CodexAuthStatus> {
  const accountId =
    extractAccountId(tokens.id_token) ?? extractAccountId(tokens.access_token);
  const row = {
    id: 1,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    idToken: tokens.id_token ?? null,
    accountId: accountId ?? null,
    expiresAt: jwtExpiry(tokens.access_token),
    updatedAt: new Date(),
  };
  await db
    .insert(codexCredentials)
    .values(row)
    .onConflictDoUpdate({ target: codexCredentials.id, set: row });
  return codexAuthStatus();
}

/** Start a device-code login and persist the values needed for server polling. */
export async function startCodexLogin() {
  await sweepExpiredAttempts();
  const deviceCode = await requestDeviceCode();
  // The orchestrator stores one Codex credential, so a restarted sign-in
  // atomically supersedes any older attempt. A failed network request above
  // leaves the still-valid prior attempt intact.
  await db.transaction(async (tx) => {
    await tx.delete(codexLoginAttempts);
    await tx.insert(codexLoginAttempts).values({
      deviceAuthId: deviceCode.deviceAuthId,
      userCode: deviceCode.userCode,
      intervalSeconds: deviceCode.intervalSeconds,
      createdAt: new Date(),
    });
  });
  return deviceCode;
}

/** Poll OpenAI once and complete the token exchange when the user has approved. */
export async function completeCodexLogin(deviceAuthId: string): Promise<CodexAuthStatus> {
  await sweepExpiredAttempts();
  const [attempt] = await db
    .select()
    .from(codexLoginAttempts)
    .where(eq(codexLoginAttempts.deviceAuthId, deviceAuthId))
    .limit(1);
  if (!attempt) {
    throw new CodexLoginError(
      "NO_ATTEMPT",
      "That sign-in has expired or was already used. Start a new one."
    );
  }

  const result = await pollDeviceAuthorization(attempt.deviceAuthId, attempt.userCode);
  if (result.status === "pending") return codexAuthStatus();

  // Burn the attempt before exchanging the single-use authorization code.
  await db
    .delete(codexLoginAttempts)
    .where(eq(codexLoginAttempts.deviceAuthId, attempt.deviceAuthId));
  const tokens = await exchangeAuthorizationCode(
    result.authorizationCode,
    result.codeVerifier
  );
  return saveCodexTokens(tokens);
}

/**
 * The stored access token, refreshed in place if it is at or near expiry. This
 * is what gets forwarded to workers as CODEX_ACCESS_TOKEN at dispatch time, so
 * refreshing here is what keeps a long-lived sandbox from booting with a token
 * that dies mid-run.
 */
export async function resolveStoredAccessToken(): Promise<string | undefined> {
  const [cred] = await db.select().from(codexCredentials).limit(1);
  if (!cred?.accessToken) return undefined;
  if (!isNearlyExpired(cred.expiresAt) || !cred.refreshToken) return cred.accessToken;

  const refreshed = await refreshCodexTokens(cred.refreshToken);
  // A failed refresh still hands back the old token: it may have enough life
  // left for this dispatch, and the alternative is failing a run outright.
  if (!refreshed) return cred.accessToken;

  await db
    .update(codexCredentials)
    .set({
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? cred.refreshToken,
      expiresAt: jwtExpiry(refreshed.access_token),
      updatedAt: new Date(),
    })
    .where(eq(codexCredentials.id, cred.id));
  return refreshed.access_token;
}

/**
 * The full stored token set, refreshed in place if it is at or near expiry.
 * `resolveStoredAccessToken` is the access-token-only view of this — the Codex
 * *backend* (lib/agent-backend/codex-auth.ts) needs the rest too, because the
 * `codex` CLI authenticates from an auth.json carrying the whole set rather
 * than from a bare bearer.
 */
export async function resolveStoredCredential(): Promise<StoredCodexCredential | undefined> {
  const [cred] = await db.select().from(codexCredentials).limit(1);
  if (!cred?.accessToken) return undefined;
  if (!isNearlyExpired(cred.expiresAt) || !cred.refreshToken) return toStored(cred);

  const refreshed = await refreshCodexTokens(cred.refreshToken);
  if (!refreshed) return toStored(cred);

  const next = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? cred.refreshToken,
    expiresAt: jwtExpiry(refreshed.access_token),
    updatedAt: new Date(),
  };
  await db.update(codexCredentials).set(next).where(eq(codexCredentials.id, cred.id));
  return toStored({ ...cred, ...next });
}

export interface StoredCodexCredential {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
}

function toStored(cred: {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
}): StoredCodexCredential {
  return {
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken ?? undefined,
    idToken: cred.idToken ?? undefined,
    accountId: cred.accountId ?? undefined,
  };
}

/** Snapshot of the stored credential + whether a login is outstanding. */
export async function codexAuthStatus(): Promise<CodexAuthStatus> {
  const [cred] = await db.select().from(codexCredentials).limit(1);
  const [attempt] = await db
    .select({ deviceAuthId: codexLoginAttempts.deviceAuthId })
    .from(codexLoginAttempts)
    .limit(1);
  return {
    signedIn: Boolean(cred?.accessToken),
    pending: Boolean(attempt),
    accountId: cred?.accountId ?? undefined,
    expiresAt: cred?.expiresAt?.toISOString(),
    updatedAt: cred?.updatedAt?.toISOString(),
  };
}

/** Revoke the token (best-effort) and drop the credential + any attempts. */
export async function codexLogout(): Promise<CodexAuthStatus> {
  const [cred] = await db.select().from(codexCredentials).limit(1);
  if (cred?.accessToken) await revokeToken(cred.accessToken);
  await db.delete(codexCredentials);
  await db.delete(codexLoginAttempts);
  return codexAuthStatus();
}

async function sweepExpiredAttempts(): Promise<void> {
  await db
    .delete(codexLoginAttempts)
    .where(lt(codexLoginAttempts.createdAt, new Date(Date.now() - ATTEMPT_TTL_MS)));
}

export const __testables = { ATTEMPT_TTL_MS };
