import { NextResponse, type NextRequest } from "next/server";
import * as agent from "@/lib/agent";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = parseInt(id, 10);
    if (!Number.isFinite(sessionId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    return NextResponse.json(await agent.cancelSession(sessionId));
  } catch (e) {
    return errorResponse(e);
  }
}
