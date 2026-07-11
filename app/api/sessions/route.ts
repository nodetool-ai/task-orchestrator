import { NextResponse, type NextRequest } from "next/server";
import * as agent from "@/lib/agent";
import { errorResponse } from "@/lib/api";
import { isTerminalStatus } from "@/lib/run-state";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const all = await agent.listSessions();
    const active = sp.get("active");
    return NextResponse.json(
      // "active" == not in a terminal state. Use the shared terminal set so
      // closed / budget_exhausted sessions aren't reported active either.
      active === "true" ? all.filter((s) => !isTerminalStatus(s.status)) : all
    );
  } catch (e) {
    return errorResponse(e);
  }
}
