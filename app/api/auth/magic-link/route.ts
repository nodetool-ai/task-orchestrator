import { NextRequest, NextResponse } from "next/server";
import { createMagicToken } from "@/lib/magic-link";
import { findUser } from "@/lib/users";
import { isAuthDisabled } from "@/lib/auth-mode";

export const dynamic = "force-dynamic";

// NOTE: this route is reachable without a session (middleware bypasses
// /api/auth/*), so it must never leak whether an email belongs to a real
// account, and must never hand a login token to an unauthenticated caller in
// production.
//
// Contract:
//   - The response is ALWAYS {ok:true} with an identical shape and timing
//     regardless of whether the email exists — there is no enumeration oracle.
//   - The real token `url` is only ever returned in local development
//     (isAuthDisabled(), i.e. NODE_ENV==='development') AND for an existing
//     user, purely as a dev convenience. In development the whole login gate is
//     already disabled, so this leaks nothing new.
//   - In production the token is NEVER returned. There is no mailer in this
//     repo; a magic link must be delivered out-of-band by an admin running the
//     CLI `user link <email>` command (see cli.ts).
//
// Only POST is exposed — a GET variant that 404'd on unknown emails (and echoed
// the address back) was an unauthenticated user-enumeration / token-minting
// vector and has been removed.
export async function POST(req: NextRequest) {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const user = findUser(email);
  // Only mint + return a token as a dev convenience: development (login gate
  // already off) and only for an existing user. Production never returns it.
  if (isAuthDisabled() && user) {
    const token = await createMagicToken(user.email);
    const url = `${req.nextUrl.origin}/login-link?token=${encodeURIComponent(token)}`;
    return NextResponse.json({ ok: true, url });
  }
  // Identical shape/timing whether or not the email exists — no oracle.
  return NextResponse.json({ ok: true });
}
