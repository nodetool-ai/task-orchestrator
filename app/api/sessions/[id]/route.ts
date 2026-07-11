import { NextResponse, type NextRequest } from "next/server";
import * as agent from "@/lib/agent";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = parseInt(id, 10);
    if (!Number.isFinite(sessionId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    const session = await agent.getSession(sessionId);
    if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const events = await agent.getSessionEvents(session.id);
    return NextResponse.json({ ...session, events, live: agent.isLive(session.id) });
  } catch (e) {
    return errorResponse(e);
  }
}
