import { NextRequest, NextResponse } from "next/server";
import { createMagicToken } from "@/lib/magic-link";
import { findUser } from "@/lib/users";

export const dynamic = "force-dynamic";

// NOTE: this route is reachable without a session (middleware bypasses
// /api/auth/*), so it must never leak whether an email belongs to a real
// account. Only POST is exposed — a GET variant that 404'd on unknown emails
// (and echoed the address back) was an unauthenticated user-enumeration /
// token-minting vector and has been removed.
export async function POST(req: NextRequest) {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const user = findUser(email);
  if (!user) {
    // Don't leak whether the email exists
    return NextResponse.json({ ok: true });
  }
  const token = await createMagicToken(user.email);
  const url = `${req.nextUrl.origin}/login-link?token=${encodeURIComponent(token)}`;
  return NextResponse.json({ ok: true, url });
}
