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

// A null userId means "no scoping" in lib/chat — an id-less session must fail
// closed here rather than gain read/write access to every user's chats.
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const uid = await userId();
    if (uid == null) return unauthorized();
    const chatId = Number(id);
    if (!Number.isFinite(chatId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const c = await chat.getChat(chatId, uid);
    if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const messages = await chat.listMessages(c.id);
    return NextResponse.json({ chat: c, messages });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const uid = await userId();
    if (uid == null) return unauthorized();
    const chatId = Number(id);
    if (!Number.isFinite(chatId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    await chat.deleteChat(chatId, uid);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const uid = await userId();
    if (uid == null) return unauthorized();
    const chatId = Number(id);
    if (!Number.isFinite(chatId)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await req.json()) as {
      title?: string;
      model?: string | null;
      repoId?: string | null;
    };

    const patch: chat.UpdateChatSettings = {};
    if (typeof body.title === "string" && body.title.trim()) {
      patch.title = body.title.trim().slice(0, 200);
    }
    if (body.model !== undefined) {
      patch.model =
        typeof body.model === "string" && body.model.trim()
          ? body.model.trim().slice(0, 100)
          : null;
    }
    if (body.repoId !== undefined) {
      patch.repoId =
        typeof body.repoId === "string" && body.repoId.trim() ? body.repoId.trim() : null;
    }

    await chat.updateChatSettings(chatId, patch, uid);
    return NextResponse.json(await chat.getChat(chatId, uid));
  } catch (e) {
    return errorResponse(e);
  }
}
