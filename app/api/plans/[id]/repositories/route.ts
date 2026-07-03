import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { planRepositorySchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Attach a single repository to a plan. POST body: { repoId }.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { repoId } = planRepositorySchema.parse(await req.json());
    const plan = await repo.addPlanRepository(id, repoId);
    return NextResponse.json(plan);
  } catch (e) {
    return errorResponse(e);
  }
}
