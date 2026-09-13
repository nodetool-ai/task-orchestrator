import { type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as runs from "@/lib/runs";
import { runGitStatus } from "@/lib/run-git-status";

export const dynamic = "force-dynamic";

// The run's git state: which files its checkout touched and how many lines it
// added and removed, split into what the branch has committed on top of its
// base and what is still uncommitted in the worktree. The run page renders a
// snapshot server-side; this endpoint backs the panel's refresh button so the
// numbers can be re-read while a run is still working.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await requireBearer(req);
  if (denied) return denied;
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return Response.json({ error: "Bad id" }, { status: 400 });
  }
  try {
    const run = await runs.get(runId);
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(await runGitStatus(run));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
