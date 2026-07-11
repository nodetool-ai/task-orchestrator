import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import * as runs from "@/lib/runs";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

const PROCEED_MESSAGES = {
  approve_spec:
    "Approved the spec — create the plan and draft the implementation plan.",
  approve_plan: "Approved the implementation plan — create the tasks.",
} as const;

const REQUIRED_STAGE = {
  approve_spec: "spec_review",
  approve_plan: "plan_review",
} as const;

const NEXT_STAGE = {
  approve_spec: "building_plan",
  approve_plan: "committing",
} as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const runId = parseInt(id, 10);
    if (!Number.isFinite(runId)) {
      return NextResponse.json({ error: "Bad id" }, { status: 400 });
    }

    const run = await runs.get(runId);
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

    let body: { action?: unknown };
    try {
      body = (await req.json()) as { action?: unknown };
    } catch {
      return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
    }

    const action = body.action;
    if (action !== "approve_spec" && action !== "approve_plan") {
      return NextResponse.json(
        { error: "action must be 'approve_spec' or 'approve_plan'" },
        { status: 400 }
      );
    }

    const currentStage = run.planningStage ?? "gathering";
    if (currentStage !== REQUIRED_STAGE[action]) {
      return NextResponse.json(
        {
          error: `Action '${action}' requires stage '${REQUIRED_STAGE[action]}' but run is in '${currentStage}'`,
        },
        { status: 409 }
      );
    }

    await repo.setPlanningStage(runId, NEXT_STAGE[action]);

    const session = await auth();
    const author = session?.user?.email ?? "user";
    const text = PROCEED_MESSAGES[action];

    void (async () => {
      try {
        for await (const ev of runs.append({ runId, role: "user", text, author })) {
          if (ev.type === "error") {
            console.error(`[planning approve] run=${runId} append error:`, ev.error);
          }
        }
      } catch (err) {
        // Fire-and-forget: a throw here would otherwise be an unhandled
        // rejection (the response has already been sent).
        console.error(`[planning approve] run=${runId} append failed:`, err);
      }
    })();

    return NextResponse.json({ ok: true, planningStage: NEXT_STAGE[action] });
  } catch (e) {
    return errorResponse(e);
  }
}
