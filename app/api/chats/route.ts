import { NextResponse } from "next/server";
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
    return NextResponse.json(chat.listChats(uid));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST() {
  try {
    const uid = await userId();
    const created = chat.createChat(uid);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
