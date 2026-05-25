import { NextRequest, NextResponse } from "next/server";
import { createMagicToken } from "@/lib/magic-link";
import { findUser } from "@/lib/users";

export const dynamic = "force-dynamic";

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

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }
  const user = findUser(email);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const token = await createMagicToken(user.email);
  const url = `${req.nextUrl.origin}/login-link?token=${encodeURIComponent(token)}`;
  return NextResponse.json({ ok: true, url, email: user.email });
}
