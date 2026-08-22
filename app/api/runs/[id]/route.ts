import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as runs from "@/lib/runs";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Bearer gate for the terminal cockpit (tui T-tui-11, lib/api-auth): a
    // presented token that does not verify is a 401; no Authorization header
    // means the middleware session gate already vouched for the request.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    const run = await runs.get(runId);
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const messages = await runs.listMessages(runId);
    return NextResponse.json({ ...run, messages, live: runs.isLive(runId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// PATCH supports a small set of actions on a run:
//   { action: "close" }   → transition idle/active run to `closed`
//   { action: "cancel" }  → abort in-flight worker and mark cancelled
//
// We model this as PATCH (rather than POST /close) to keep the surface
// route-flat: a unified /runs/[id] page already POSTs to ./messages for new
// turns; close/cancel are state transitions on the same resource.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Bearer gate — see the note above.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }
    let body: { action?: string };
    try {
      body = (await req.json()) as { action?: string };
    } catch {
      return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
    }
    if (body.action === "close") {
      const updated = await runs.close(runId);
      return NextResponse.json(updated);
    }
    if (body.action === "cancel") {
      const updated = await runs.cancel(runId);
      return NextResponse.json(updated);
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
