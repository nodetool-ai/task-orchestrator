// Bearer-token authentication for the API routes the terminal cockpit uses
// (tui T-tui-11).
//
// The server's primary gate is the NextAuth session cookie enforced in
// middleware.ts. A terminal has no cookie jar, so `orch` sends
// `Authorization: Bearer tot_…` — the SAME API tokens `/api/mcp` already
// accepts, issued and revoked from /settings?tab=tokens (lib/api-tokens).
// Nothing new is minted here and there is no new table.
//
// Two entry points, matching two route postures:
//
//   requireBearer(req)   — routes that carry no identity of their own
//                          (/api/tasks, /api/plans, …). A request with NO
//                          Authorization header is passed straight through
//                          unchanged (middleware already vouched for it,
//                          or local dev has the gate off); a header that
//                          does not verify is a 401.
//
//   resolveApiActor(req) — routes that need to know WHO is calling
//                          (/api/runs/overview, /api/inbox, message author,
//                          run owner). Bearer first, session second.
//
// Middleware only forwards an Authorization-bearing request for the cockpit's
// route allowlist, so every path that can be reached with a bearer verifies it
// here. The plaintext token is never logged.

import { NextResponse } from "next/server";
import { verifyToken } from "@/lib/api-tokens";
import { getUserById } from "@/lib/users";

/** One line telling a terminal user how to get a working ORCH_TOKEN. */
export const TOKEN_HINT =
  "set ORCH_TOKEN to an API token from /settings?tab=tokens";

export interface ApiActor {
  /** users.id, or null for a session whose JWT carried no numeric id. */
  userId: number | null;
  email: string;
  via: "token" | "session";
}

export type BearerResult =
  /** No Authorization header at all — the caller decides what that means. */
  | { kind: "absent" }
  /** A header was presented and did not verify. Always a 401. */
  | { kind: "invalid" }
  | { kind: "ok"; actor: ApiActor };

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Verify an `Authorization: Bearer tot_…` header against the api_tokens table.
 * Never throws for a bad header — a malformed or unknown token is "invalid".
 */
export async function authenticateBearer(req: {
  headers: Headers;
}): Promise<BearerResult> {
  const header = req.headers.get("authorization");
  if (!header) return { kind: "absent" };
  const m = BEARER.exec(header.trim());
  if (!m) return { kind: "invalid" };
  const verified = await verifyToken(m[1]);
  if (!verified) return { kind: "invalid" };
  const user = await getUserById(verified.userId);
  if (!user) return { kind: "invalid" };
  return {
    kind: "ok",
    actor: { userId: user.id, email: user.email, via: "token" },
  };
}

/** The 401 every bearer-authenticated route answers with. */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized", hint: TOKEN_HINT },
    { status: 401 }
  );
}

/**
 * Guard for routes that do not otherwise look at the caller: returns a 401
 * response when a presented bearer token is bad, and `null` (carry on) both
 * when the token is good and when no Authorization header was sent.
 */
export async function requireBearer(req: {
  headers: Headers;
}): Promise<NextResponse | null> {
  const result = await authenticateBearer(req);
  return result.kind === "invalid" ? unauthorizedResponse() : null;
}

export type ActorResult =
  /** `actor` is null when the request carried no credentials at all. */
  | { ok: true; actor: ApiActor | null }
  | { ok: false };

/**
 * Identity for an API request: the Bearer API token when one is presented,
 * otherwise the NextAuth session (which in local dev is the synthetic dev-user
 * session, so the no-token path keeps working).
 */
export async function resolveApiActor(req: {
  headers: Headers;
}): Promise<ActorResult> {
  const bearer = await authenticateBearer(req);
  if (bearer.kind === "invalid") return { ok: false };
  if (bearer.kind === "ok") return { ok: true, actor: bearer.actor };

  // Imported lazily: the bearer-only helpers above must stay free of the
  // NextAuth module graph so routes that never look at the session (and their
  // tests) do not drag it in.
  const { auth } = await import("@/auth");
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return { ok: true, actor: null };
  const rawId = (session.user as { id?: string } | undefined)?.id;
  const parsed = rawId == null ? NaN : Number(rawId);
  return {
    ok: true,
    actor: {
      userId: Number.isFinite(parsed) ? parsed : null,
      email,
      via: "session",
    },
  };
}
