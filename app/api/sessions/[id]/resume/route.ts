import { NextResponse, type NextRequest } from "next/server";
import * as agent from "@/lib/agent";
import { startSessionSchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const priorId = parseInt(id, 10);
    // Guard before the id reaches Postgres: an un-parseable id yields NaN, which
    // otherwise surfaces as an opaque 500 from the DB layer rather than a 400.
    if (!Number.isFinite(priorId)) {
      return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
    }
    const prior = await agent.getSession(priorId);
    if (!prior) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const raw =
      req.headers.get("content-length") === "0"
        ? {}
        : await req.json().catch(() => ({}));
    const input = startSessionSchema.parse(raw);
    const session = await agent.startSession({
      taskId: prior.taskId,
      model: input.model ?? prior.model ?? undefined,
      // Omitted → startSession inherits the prior session's backend.
      backend: input.backend ?? null,
      baseBranch: input.baseBranch,
      resumeOf: priorId,
    });
    return NextResponse.json(session, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
