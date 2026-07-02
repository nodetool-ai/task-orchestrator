"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderGit2 } from "lucide-react";
import type { RepositoryRow } from "@/lib/types";
import { describe } from "@/lib/utils";
import { RepositoryPicker } from "@/components/pickers/repository-picker";

interface Props {
  taskId: string;
  currentRepoId: string | null;
  currentRepo: RepositoryRow | null;
  /** Repos attached to the parent plan — the only valid values. */
  options: RepositoryRow[];
}

export function TaskRepoSelector({
  taskId,
  currentRepoId,
  currentRepo,
  options,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (options.length === 0) {
    return <span className="text-muted-foreground">no repos on plan</span>;
  }

  const set = (next: string) => {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoId: next || null }),
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

  // If the plan only has one repo and the task already targets it, render
  // a static badge instead of a dropdown to reduce noise.
  if (options.length === 1 && currentRepoId === options[0].id && currentRepo) {
    return (
      <Link
        href={`/repositories/${currentRepo.id}`}
        className="inline-flex items-center gap-1 text-foreground hover:underline"
      >
        <FolderGit2 className="size-3" />
        <span className="font-mono">{currentRepo.name}</span>
      </Link>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <FolderGit2 className="size-3 text-muted-foreground" />
      <RepositoryPicker
        repositories={options}
        value={currentRepoId ?? ""}
        onChange={set}
        disabled={pending}
        emptyLabel="— unset —"
        size="compact"
      />
      {error && <span className="text-[11px] text-state-blocked">{error}</span>}
    </div>
  );
}
