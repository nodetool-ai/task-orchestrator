import { type NextRequest } from "next/server";
import * as runs from "@/lib/runs";
import { fetchContainerLog } from "@/lib/run-dispatch";

export const dynamic = "force-dynamic";

// The run's worker output — the debugging channel for failures that never reach
// the transcript (OOM kill, crash before the SDK started, git auth, ...). For a
// local docker worker, while the container is alive this reads the live log
// straight from Docker; after it dies it serves the tail the worker monitor
// captured onto the run row before removing the container. For a Fly worker
// (no container) it serves the runner.log tail the worker flushes onto the run
// row during the run and at exit.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return Response.json({ error: "Bad id" }, { status: 400 });
  }
  try {
    const stored = await runs.getWorkerLog(runId);
    if (!stored) return Response.json({ error: "Not found" }, { status: 404 });

    if (stored.scope && process.env.TASK_ORCH_WORKER_IMAGE) {
      const live = await fetchContainerLog(stored.scope);
      if (live != null) {
        return Response.json({ source: "live", log: live, exitCode: stored.exitCode });
      }
    }
    if (stored.log != null) {
      return Response.json({ source: "stored", log: stored.log, exitCode: stored.exitCode });
    }
    return Response.json({ source: null, log: "", exitCode: stored.exitCode });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
