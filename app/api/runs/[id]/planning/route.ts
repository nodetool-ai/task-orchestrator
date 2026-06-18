import { NextResponse, type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import * as repo from "@/lib/repo";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Canned messages that wake the agent after each approval gate.
const APPROVE_MESSAGES: Record<string, string> = {
  approve_spec:
    "Approved the spec — create the plan and draft the implementation plan.",
  approve_plan: "Approved the implementation plan — create the tasks.",
};

// Required stage before each approval action.
const REQUIRED_STAGE: Record<string, string> = {
  approve_spec: "spec_review",
  approve_plan: "plan_review",
};

// Stage to advance to after each approval.
const NEXT_STAGE: Record<string, "building_plan" | "committing"> = {
  approve_spec: "building_plan",
  approve_plan: "committing",
};

/**
 * POST /api/runs/[id]/planning
 *
 * Body: { action: "approve_spec" | "approve_plan" }
 *
 * Advances the planning stage and appends a canned user message to wake the
 * agent. Returns 409 if the run is not in the expected stage (stale UI /
 * double-click guard).
 */
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

    let body: { action?: string };
    try {
      body = (await req.json()) as { action?: string };
    } catch {
      return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
    }

    const { action } = body;
    if (action !== "approve_spec" && action !== "approve_plan") {
      return NextResponse.json(
        { error: "action must be 'approve_spec' or 'approve_plan'" },
        { status: 400 }
      );
    }

    const run = runs.get(runId);
    if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Guard: the run must be at the expected stage (409 on mismatch).
    if (run.planningStage !== REQUIRED_STAGE[action]) {
      return NextResponse.json(
        {
          error: `Cannot ${action} from stage '${run.planningStage ?? "null"}'; expected '${REQUIRED_STAGE[action]}'`,
        },
        { status: 409 }
      );
    }

    // Advance the stage — setPlanningStage enforces the transition table.
    repo.setPlanningStage(runId, NEXT_STAGE[action]);

    // Append the canned proceed message and wake the agent in the background.
    const text = APPROVE_MESSAGES[action];
    void (async () => {
      for await (const _ of runs.append({ runId, role: "user", text, author: "system" })) {
        // drive the generator; events discarded (UI polls separately)
      }
    })();

    const updated = runs.get(runId)!;
    return NextResponse.json(updated);
  } catch (e) {
    return errorResponse(e);
  }
}
