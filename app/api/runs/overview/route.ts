import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { errorResponse } from "@/lib/api";
import { getRunOverview } from "@/lib/run-overview";
import type { RunIndexRow } from "@/lib/run-index";

export const dynamic = "force-dynamic";

// Polled by the unified /runs index (components/runs/runs-index.tsx) to keep
// run/chat statuses live. Same auth posture as /api/live-sessions: an
// unauthenticated poll gets an empty list, not an error.
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ rows: [] satisfies RunIndexRow[] });
    }
    return NextResponse.json({ rows: await getRunOverview() });
  } catch (e) {
    return errorResponse(e);
  }
}
