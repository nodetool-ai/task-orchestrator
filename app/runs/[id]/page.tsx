import { notFound } from "next/navigation";
import { auth } from "@/auth";
import * as runs from "@/lib/runs";
import * as repo from "@/lib/repo";
import { RunView } from "@/components/runs/run-view";

export const dynamic = "force-dynamic";

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const runId = Number(id);
  if (!Number.isFinite(runId)) notFound();

  const run = runs.get(runId);
  if (!run) notFound();

  const session = await auth();
  const messages = runs.listMessages(runId);
  const repositories = repo.listRepositories().map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath,
  }));

  // Resolve a friendly parent label for the breadcrumb. Cheap single-row
  // lookup; we only need the title (or fallback to "#id").
  let parent: { id: number; title: string } | null = null;
  if (run.parentRunId != null) {
    const p = runs.get(run.parentRunId);
    if (p) {
      parent = { id: p.id, title: p.title ?? `Run #${p.id}` };
    } else {
      parent = { id: run.parentRunId, title: `Run #${run.parentRunId}` };
    }
  }

  // Task info used by the implement-run header (PR link, branch, task id).
  const task = run.taskId ? repo.getTask(run.taskId) : null;

  // Persona for the header display.
  const persona = run.personaId ? repo.getPersona(run.personaId) : null;

  return (
    <RunView
      run={run}
      initialMessages={messages}
      live={runs.isLive(runId)}
      userEmail={session?.user?.email ?? null}
      repositories={repositories}
      parent={parent}
      task={task ? { id: task.id, title: task.title } : null}
      personaName={persona?.name ?? null}
    />
  );
}
