import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as repo from "@/lib/repo";
import { createPlanSchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Bearer gate for the terminal cockpit (tui T-tui-11, lib/api-auth): a
    // presented token that does not verify is a 401; no Authorization header
    // means the middleware session gate already vouched for the request.
    const denied = await requireBearer(req);
    if (denied) return denied;
    return NextResponse.json(await repo.listPlans());
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    // Bearer gate — see the note above.
    const denied = await requireBearer(req);
    if (denied) return denied;
    const input = createPlanSchema.parse(await req.json());
    const plan = await repo.createPlan(input);
    return NextResponse.json(plan, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
