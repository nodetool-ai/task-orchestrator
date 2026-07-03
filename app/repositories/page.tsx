import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import * as repo from "@/lib/repo";
import { NewRepositoryForm } from "@/components/repositories/repository-form";
import { formatDate, relativeDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function RepositoriesPage() {
  const repositories = await repo.listRepositories();

  return (
    <div style={{ padding: "20px 20px 80px", maxWidth: 1480, margin: "0 auto" }}>
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            Git checkouts the orchestrator drives. Each plan and chat picks one.
          </p>
        </div>
        <NewRepositoryForm />
      </header>

      {repositories.length === 0 ? (
        <EmptyState>No repositories configured.</EmptyState>
      ) : (
        <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/40">
          {repositories.map((r) => (
            <Link
              key={r.id}
              href={`/repositories/${r.id}`}
              className="block px-4 py-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <FolderGit2 className="size-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{r.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{r.id}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  default: {r.defaultBranch}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground font-mono">
                {r.localPath ? (
                  <span>local: {r.localPath}</span>
                ) : (
                  <span className="text-state-blocked">local path not set</span>
                )}
                {r.remote && <span>remote: {r.remote}</span>}
                <span>created {formatDate(r.createdAt)}</span>
                <span>· {relativeDate(r.updatedAt)}</span>
              </div>
              {r.description && (
                <div className="mt-1 text-xs text-muted-foreground">{r.description}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
