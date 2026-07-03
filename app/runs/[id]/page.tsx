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

  const run = await runs.get(runId);
  if (!run) notFound();

  const session = await auth();
  const messages = await runs.listMessages(runId);
  // Seed the read-only SSE tail so it streams only rows written after this
  // server render — the conversation above is already the snapshot.
  const initialCursor = await runs.streamCursor(runId);
  const repositories = (await repo.listRepositories()).map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath,
  }));

  // Resolve a friendly parent label for the breadcrumb. Cheap single-row
  // lookup; we only need the title (or fallback to "#id").
  let parent: { id: number; title: string } | null = null;
  if (run.parentRunId != null) {
    const p = await runs.get(run.parentRunId);
    if (p) {
      parent = { id: p.id, title: p.title ?? `Run #${p.id}` };
    } else {
      parent = { id: run.parentRunId, title: `Run #${run.parentRunId}` };
    }
  }

  // Task info used by the implement-run header (PR link, branch, task id).
  const task = run.taskId ? await repo.getTask(run.taskId) : null;

  // Persona for the header display.
  const persona = run.personaId ? await repo.getPersona(run.personaId) : null;

  // Bound the run view to the viewport (minus the 48px top nav) so its internal
  // flex column scrolls the message stream while the composer stays pinned to
  // the bottom. Without a definite height here, RunView's `h-full` collapses
  // and the whole document scrolls (the composer scrolls off-screen).
  return (
    <div className="h-[calc(100dvh-3rem)] overflow-hidden">
      <RunView
        run={run}
        initialMessages={messages}
        initialCursor={initialCursor}
        live={runs.isLive(runId)}
        userEmail={session?.user?.email ?? null}
        repositories={repositories}
        parent={parent}
        task={task ? { id: task.id, title: task.title } : null}
        personaName={persona?.name ?? null}
      />
    </div>
  );
}
