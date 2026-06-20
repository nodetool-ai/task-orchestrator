import { NextResponse, type NextRequest } from "next/server";
import * as repo from "@/lib/repo";
import { prMergeability } from "@/lib/gh-merge";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Mergeability of the task's latest PR, for gating the `Resolve merge` button.
// Returns { mergeable, baseRef, attachedRunId }. No PR / no attached run →
// UNKNOWN, so the button stays hidden.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = repo.getTask(id);
    if (!task) return errorResponse(new repo.RepoError(`Task ${id} not found`, 404));

    const attached = repo.resolveAttachedRun(id);
    if (!task.prUrl) {
      return NextResponse.json({
        mergeable: "UNKNOWN",
        baseRef: null,
        attachedRunId: attached?.id ?? null,
      });
    }
    const { mergeable, baseRef } = await prMergeability(task.prUrl);
    return NextResponse.json({ mergeable, baseRef, attachedRunId: attached?.id ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
