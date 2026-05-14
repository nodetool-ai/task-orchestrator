import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { findUser } from "@/lib/users";
import { revokeToken } from "@/lib/api-tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const u = findUser(email);
  if (!u) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const tokenId = Number(id);
  if (!Number.isFinite(tokenId)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  const ok = revokeToken(tokenId, u.id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
