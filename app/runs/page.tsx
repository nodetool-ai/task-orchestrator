// The unified Chats + Runs page. Every chat is a run (goal '<chat>'), and
// runs may spawn child runs (parent_run_id) — this page shows them all in one
// place: new-chat composer on top, then the run forest with children nested
// under their parents, statuses kept live by the client component's polling.
import * as repo from "@/lib/repo";
import { getRunOverview } from "@/lib/run-overview";
import { getDefaultModel } from "@/lib/chat";
import { RunsIndex } from "@/components/runs/runs-index";

export const dynamic = "force-dynamic";

interface SearchParams {
  repo?: string;
  task?: string;
}

export default async function RunsIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const [rows, repositories] = await Promise.all([
    getRunOverview(),
    repo.listRepositories(),
  ]);
  const repoOptions = repositories.map((r) => ({ id: r.id, name: r.name }));

  const filterRepo = sp.repo
    ? { id: sp.repo, name: repoOptions.find((r) => r.id === sp.repo)?.name ?? sp.repo }
    : null;
  let filterTask: { id: string; title: string } | null = null;
  if (sp.task) {
    const t = await repo.getTask(sp.task);
    filterTask = { id: sp.task, title: t?.title ?? sp.task };
  }

  return (
    <RunsIndex
      initialRows={rows}
      repositories={repoOptions}
      defaultModel={getDefaultModel()}
      filterRepo={filterRepo}
      filterTask={filterTask}
    />
  );
}
