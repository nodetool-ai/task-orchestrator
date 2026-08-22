import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/auth";
import { errorResponse } from "@/lib/api";
import { listGlobalInbox, type Audience, type GlobalInboxRow } from "@/lib/inbox";

export const dynamic = "force-dynamic";

const AUDIENCES: Audience[] = ["owner", "supervisor"];

const DEFAULT_LIMIT = 100;

// The terminal cockpit's needs-you view and its `⚑ n` counts (tui T-tui-04):
// pending inbox events across LIVE runs plus the runs parked on an open
// question, newest first. Same auth posture as /api/runs/overview — an
// unauthenticated poll gets an empty list, not an error, so the TUI works
// against a dev server with auth disabled.
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const params = req.nextUrl.searchParams;

    const audienceParam = params.get("audience");
    if (audienceParam !== null && !AUDIENCES.includes(audienceParam as Audience)) {
      return NextResponse.json(
        { error: `Unknown audience '${audienceParam}' (expected owner|supervisor)` },
        { status: 400 }
      );
    }
    const audience: Audience = (audienceParam as Audience | null) ?? "owner";

    // A garbage `limit` falls back to the default rather than 400ing: the value
    // only bounds a read, and the cockpit polls this on a timer.
    const limitParam = Number(params.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;

    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ items: [] satisfies GlobalInboxRow[] });
    }
    return NextResponse.json({ items: await listGlobalInbox(audience, limit) });
  } catch (e) {
    return errorResponse(e);
  }
}
