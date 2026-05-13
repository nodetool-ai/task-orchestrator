import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; repoId: string }> }
) {
  try {
    const { id, repoId } = await params;
    const plan = repo.removePlanRepository(id, repoId);
    return NextResponse.json(plan);
  } catch (e) {
    return errorResponse(e);
  }
}
