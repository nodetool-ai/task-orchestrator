import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { addCriterionSchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const input = addCriterionSchema.parse(await req.json());
    await repo.addCriterion(id, input.text);
    return NextResponse.json(await repo.getTask(id));
  } catch (e) {
    return errorResponse(e);
  }
}
