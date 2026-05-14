import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { findUser } from "@/lib/users";
import { createToken, listTokens } from "@/lib/api-tokens";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function userId(): Promise<number | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  const u = findUser(email);
  return u?.id ?? null;
}

export async function GET() {
  const id = await userId();
  if (id === null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ tokens: listTokens(id) });
}

export async function POST(req: NextRequest) {
  const id = await userId();
  if (id === null) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  try {
    const created = await createToken(id, body.name);
    // Plaintext is part of the response ONCE.
    return NextResponse.json({
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      token: created.token,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
