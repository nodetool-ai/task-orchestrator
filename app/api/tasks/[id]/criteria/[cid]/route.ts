import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { updateCriterionSchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> }
) {
  try {
    const { id, cid } = await params;
    const criterionId = parseInt(cid, 10);
    if (!Number.isFinite(criterionId)) {
      return NextResponse.json({ error: "Bad criterion id" }, { status: 400 });
    }
    const input = updateCriterionSchema.parse(await req.json());
    await repo.updateCriterion(criterionId, input, id);
    return NextResponse.json(await repo.getTask(id));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; cid: string }> }
) {
  try {
    const { id, cid } = await params;
    const criterionId = parseInt(cid, 10);
    if (!Number.isFinite(criterionId)) {
      return NextResponse.json({ error: "Bad criterion id" }, { status: 400 });
    }
    await repo.deleteCriterion(criterionId, id);
    return NextResponse.json(await repo.getTask(id));
  } catch (e) {
    return errorResponse(e);
  }
}
