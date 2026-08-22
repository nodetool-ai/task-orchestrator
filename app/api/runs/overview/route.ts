import { NextResponse, type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import { errorResponse } from "@/lib/api";
import { getRunOverview } from "@/lib/run-overview";
import type { RunIndexRow } from "@/lib/run-index";

export const dynamic = "force-dynamic";

// Polled by the unified /runs index (components/runs/runs-index.tsx) to keep
// run/chat statuses live, and by the terminal cockpit's floor. Same auth
// posture as /api/live-sessions: an unauthenticated poll gets an empty list,
// not an error. A request that DOES present a Bearer token (tui T-tui-11) is
// held to it: a token that fails to verify is a 401, never an empty list.
export async function GET(req: NextRequest) {
  try {
    const auth = await resolveApiActor(req);
    if (!auth.ok) return unauthorizedResponse();
    if (!auth.actor) {
      return NextResponse.json({ rows: [] satisfies RunIndexRow[] });
    }
    return NextResponse.json({ rows: await getRunOverview() });
  } catch (e) {
    return errorResponse(e);
  }
}
