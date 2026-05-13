import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { createRepositorySchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(repo.listRepositories());
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const input = createRepositorySchema.parse(await req.json());
    const r = repo.createRepository({
      id: input.id,
      name: input.name,
      remote: input.remote ?? undefined,
      localPath: input.localPath ?? undefined,
      defaultBranch: input.defaultBranch,
      description: input.description,
    });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
