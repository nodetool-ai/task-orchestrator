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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const uid = await userId();
    const c = await chat.getChat(Number(id), uid);
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
    await chat.deleteChat(Number(id), uid);
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

    await chat.updateChatSettings(Number(id), patch, uid);
    return NextResponse.json(await chat.getChat(Number(id), uid));
  } catch (e) {
    return errorResponse(e);
  }
}
