import { notFound } from "next/navigation";
import { auth } from "@/auth";
import * as runs from "@/lib/runs";
import * as repo from "@/lib/repo";
import { RunView } from "@/components/runs/run-view";
import { loadTemplateBuildState } from "@/lib/runner/box-template-state";
import { loadBoxBootState } from "@/lib/runner/box-boot-state";

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
  // Seed the box-template build stepper from persisted events so it renders on
  // load for a run opened mid-build (the SSE tail only forwards later rows).
  const initialTemplateBuild = await loadTemplateBuildState(runId);
  // Seed the box boot / worker-startup stepper the same way, so a run opened
  // mid-boot shows accurate progress instead of the coarse status guess.
  const initialBoxBoot = await loadBoxBootState(runId);
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

  // Child runs this run spawned (start_session / start_review stamp
  // parentRunId). list() orders by startedAt desc; the section wants id order.
  const childRows = (await runs.list({ parentRunId: runId })).sort(
    (a, b) => a.id - b.id
  );
  const childTaskTitles = new Map<string, string>();
  for (const taskId of new Set(
    childRows.flatMap((c) => (c.taskId ? [c.taskId] : []))
  )) {
    const t = await repo.getTask(taskId);
    if (t) childTaskTitles.set(taskId, t.title);
  }
  const childRuns = childRows.map((c) => ({
    id: c.id,
    goal: c.goal,
    status: c.status,
    taskId: c.taskId,
    taskTitle: c.taskId ? childTaskTitles.get(c.taskId) ?? null : null,
  }));

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
        initialTemplateBuild={initialTemplateBuild}
        initialBoxBoot={initialBoxBoot}
        live={runs.isLive(runId)}
        userEmail={session?.user?.email ?? null}
        repositories={repositories}
        parent={parent}
        childRuns={childRuns}
        task={task ? { id: task.id, title: task.title } : null}
        personaName={persona?.name ?? null}
      />
    </div>
  );
}
