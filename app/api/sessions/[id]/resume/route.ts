import { NextResponse, type NextRequest } from "next/server";
import * as agent from "@/lib/agent";
import * as runs from "@/lib/runs";
import { startSessionSchema } from "@/lib/validators";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Guard before the id reaches Postgres. Require the WHOLE param to be a
    // positive integer: parseInt("123abc") would coerce to 123 and resume an
    // unintended session, and a non-numeric id would otherwise surface as an
    // opaque 500 from the DB layer rather than a 400.
    if (!/^[0-9]+$/.test(id)) {
      return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
    }
    const priorId = Number(id);
    if (!Number.isSafeInteger(priorId) || priorId <= 0) {
      return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
    }
    const prior = await runs.get(priorId);
    if (!prior) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const raw =
      req.headers.get("content-length") === "0"
        ? {}
        : await req.json().catch(() => ({}));
    const input = startSessionSchema.parse(raw);
    // Plan-executor runs have a planId but no taskId, so the task-session path
    // below can't represent them (agent.getSession used to 404 here). Fork a
    // fresh executor generation on the same plan instead.
    if (prior.goal === "<execute>") {
      const run = await runs.resumeExecutorRun(priorId, {
        model: input.model ?? null,
        backend: input.backend ?? null,
      });
      return NextResponse.json(run, { status: 201 });
    }
    if (prior.taskId == null) {
      // Task-less non-executor runs (chats) resume in place via their own
      // message endpoint; preserve the endpoint's historical 404 for them.
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
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
