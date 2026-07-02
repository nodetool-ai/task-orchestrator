"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderGit2, Plus, X } from "lucide-react";
import type { RepositoryRow } from "@/lib/types";
import { describe } from "@/lib/utils";
import { useConfirm } from "@/components/ui/dialog-provider";

interface Props {
  planId: string;
  repos: RepositoryRow[];
  allRepositories: RepositoryRow[];
}

export function PlanRepositories({ planId, repos, allRepositories }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const attachedIds = new Set(repos.map((r) => r.id));
  const candidates = allRepositories.filter((r) => !attachedIds.has(r.id));

  const attach = (repoId: string) => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/plans/${planId}/repositories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        setAdding(false);
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  const detach = async (repoId: string) => {
    if (
      !(await confirm({
        message: `Remove ${repoId} from this plan? Tasks pinned to it will lose their repo.`,
        confirmLabel: "Remove",
        tone: "danger",
      }))
    )
      return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/plans/${planId}/repositories/${repoId}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
          Repos
        </span>
        {repos.length === 0 && (
          <span className="text-xs text-muted-foreground italic">
            No repositories attached. Sessions on tasks under this plan won&apos;t start.
          </span>
        )}
        {repos.map((r) => (
          <span
            key={r.id}
            className="group inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 pl-2 pr-1 py-0.5 text-xs"
          >
            <Link
              href={`/repositories/${r.id}`}
              className="inline-flex items-center gap-1.5 hover:underline"
            >
              <FolderGit2 className="size-3" />
              <span className="font-mono">{r.name}</span>
            </Link>
            <button
              type="button"
              onClick={() => detach(r.id)}
              disabled={pending}
              aria-label={`Remove ${r.id}`}
              className="opacity-40 hover:opacity-100 hover:text-state-blocked rounded p-0.5"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {!adding && candidates.length > 0 && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground/40"
          >
            <Plus className="size-3" /> add repo
          </button>
        )}
        {adding && (
          <span className="inline-flex items-center gap-1">
            <select
              autoFocus
              onChange={(e) => {
                if (e.target.value) attach(e.target.value);
              }}
              disabled={pending}
              defaultValue=""
              className="rounded-md border border-border/60 bg-background/60 px-2 py-0.5 text-xs"
            >
              <option value="" disabled>
                Pick repo…
              </option>
              {candidates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.id})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              cancel
            </button>
          </span>
        )}
      </div>
      {error && <p className="text-[11px] text-state-blocked">{error}</p>}
    </div>
  );
}
