import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import * as chat from "@/lib/chat";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

async function userId(): Promise<number | null> {
  const session = await auth();
  const id = session?.user?.id;
  return id ? Number(id) : null;
}

export async function GET() {
  try {
    const uid = await userId();
    // A null userId means "no scoping" in lib/chat — an id-less session must
    // fail closed here rather than list every user's chats.
    if (uid == null) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(await chat.listChats(uid));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const uid = await userId();
    if (uid == null) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    let repoId: string | undefined;
    try {
      const body = (await req.json()) as { repoId?: string | null };
      if (body && body.repoId !== undefined && body.repoId !== null) {
        repoId = body.repoId;
      }
    } catch {
      // Empty body is fine — fall back to default repo.
    }
    const created = await chat.createChat(uid, "New chat", repoId);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
