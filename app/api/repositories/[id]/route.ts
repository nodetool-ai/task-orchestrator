import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { updateRepositorySchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const r = repo.getRepository(id);
    if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const input = updateRepositorySchema.parse(await req.json());
    const r = repo.updateRepository(id, {
      name: input.name,
      remote: input.remote ?? undefined,
      localPath: input.localPath ?? undefined,
      defaultBranch: input.defaultBranch,
      description: input.description,
    });
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    repo.deleteRepository(id);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
