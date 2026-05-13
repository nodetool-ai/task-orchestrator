import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, FolderGit2 } from "lucide-react";
import * as repo from "@/lib/repo";
import * as agent from "@/lib/agent";
import { Meta } from "@/components/meta";
import { StateBadge } from "@/components/state-badge";
import { SessionStatusPill } from "@/components/session-status-pill";
import { EditRepositoryForm } from "@/components/repositories/edit-repository-form";
import { formatDate, formatDateTime, relativeDate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const r = repo.getRepository(id);
  if (!r) notFound();

  const allPlans = repo.listPlans().filter((p) => p.repos.some((r) => r.id === id));
  const allSessions = agent.listSessions().filter((s) => s.repoId === id);

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/repositories"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" /> Repositories
      </Link>

      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
          <FolderGit2 className="size-3.5" />
          <span className="tabular-nums">{r.id}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{r.name}</h1>
        {r.description && (
          <p className="text-sm text-muted-foreground">{r.description}</p>
        )}
      </header>

      <EditRepositoryForm repository={r} />

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-y-3 gap-x-6 text-xs">
        <Meta label="Local path" className="col-span-2 md:col-span-4">
          {r.localPath ? (
            <code className="font-mono text-foreground">{r.localPath}</code>
          ) : (
            <span className="text-state-blocked">not set</span>
          )}
        </Meta>
        {r.remote && (
          <Meta label="Remote" className="col-span-2 md:col-span-4">
            <code className="font-mono text-foreground">{r.remote}</code>
          </Meta>
        )}
        <Meta label="Default branch">
          <code className="font-mono text-foreground">{r.defaultBranch}</code>
        </Meta>
        <Meta label="Created">{formatDate(r.createdAt)}</Meta>
      </dl>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">Plans ({allPlans.length})</h2>
        {allPlans.length === 0 ? (
          <p className="text-xs text-muted-foreground">No plans in this repository yet.</p>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/30">
            {allPlans.map((p) => (
              <Link
                key={p.id}
                href={`/plans/${p.id}`}
                className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors"
              >
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {p.id}
                </span>
                <span className="text-sm font-medium flex-1 truncate">{p.title}</span>
                <StateBadge state={p.state} />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold tracking-tight">
          Agent sessions ({allSessions.length})
        </h2>
        {allSessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No agent sessions yet.</p>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/30">
            {allSessions.slice(0, 20).map((s) => (
              <Link
                key={s.id}
                href={`/runs/${s.id}`}
                className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors"
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  #{s.id}
                </span>
                <SessionStatusPill status={s.status} />
                <span className="font-mono text-[11px] text-muted-foreground">{s.taskId}</span>
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" title={formatDateTime(s.startedAt)}>
                  {relativeDate(s.startedAt)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
