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
  buildAuthorizationUrl,
  CodexLoginError,
  extractAccountId,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  parseDeviceCallbackInput,
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

/**
 * Begin a device-code login: mint PKCE + state, persist the verifier, and hand
 * back the URL for the user's browser. The exchange happens later, when the
 * user pastes the code into {@link completeCodexLogin}.
 */
export async function startCodexLogin(): Promise<{ authorizationUrl: string; state: string }> {
  await sweepExpiredAttempts();
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  await db.insert(codexLoginAttempts).values({ state, verifier, createdAt: new Date() });
  return { authorizationUrl: buildAuthorizationUrl({ challenge, state }), state };
}

/**
 * Finish the login from whatever the user pasted (bare code or full callback
 * URL). When the paste carries a state we verify it against the stored attempt;
 * a bare code has no state to check, so it redeems the single outstanding
 * attempt and is rejected outright if more than one is in flight.
 */
export async function completeCodexLogin(input: string): Promise<CodexAuthStatus> {
  await sweepExpiredAttempts();
  const { code, state } = parseDeviceCallbackInput(input);

  const attempt = state ? await attemptByState(state) : await soleAttempt();
  // Single-use: burn the verifier before the exchange so a replayed paste
  // cannot re-run it, and a failed exchange forces a clean restart rather than
  // leaving a half-consumed attempt around.
  await db.delete(codexLoginAttempts).where(eq(codexLoginAttempts.state, attempt.state));

  const tokens = await exchangeAuthorizationCode(code, attempt.verifier);
  return saveCodexTokens(tokens);
}

async function attemptByState(state: string) {
  const [row] = await db
    .select()
    .from(codexLoginAttempts)
    .where(eq(codexLoginAttempts.state, state))
    .limit(1);
  if (!row) {
    throw new CodexLoginError(
      "STATE_MISMATCH",
      "That sign-in has expired or was already used. Start a new one."
    );
  }
  return row;
}

async function soleAttempt() {
  const rows = await db.select().from(codexLoginAttempts).limit(2);
  if (rows.length === 0) {
    throw new CodexLoginError("NO_ATTEMPT", "No sign-in is in progress. Start one first.");
  }
  if (rows.length > 1) {
    throw new CodexLoginError(
      "AMBIGUOUS_ATTEMPT",
      "More than one sign-in is in progress. Paste the full callback URL so it can be matched, or start over."
    );
  }
  return rows[0];
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

/** Snapshot of the stored credential + whether a login is outstanding. */
export async function codexAuthStatus(): Promise<CodexAuthStatus> {
  const [cred] = await db.select().from(codexCredentials).limit(1);
  const [attempt] = await db
    .select({ state: codexLoginAttempts.state })
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
