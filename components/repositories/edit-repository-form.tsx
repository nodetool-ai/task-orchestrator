"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Save, Trash2 } from "lucide-react";
import type { RepositoryRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/dialog-provider";

interface Props {
  repository: RepositoryRow;
}

export function EditRepositoryForm({ repository }: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(repository.name);
  const [remote, setRemote] = useState(repository.remote ?? "");
  const [localPath, setLocalPath] = useState(repository.localPath ?? "");
  const [defaultBranch, setDefaultBranch] = useState(repository.defaultBranch);
  const [description, setDescription] = useState(repository.description);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/repositories/${repository.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          remote: remote.trim() || null,
          localPath: localPath.trim() || null,
          defaultBranch: defaultBranch.trim() || "main",
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error ?? `HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  const remove = async () => {
    if (
      !(await confirm({
        message: `Delete repository ${repository.id}? This is irreversible.`,
        confirmLabel: "Delete",
        tone: "danger",
      }))
    )
      return;
    startTransition(async () => {
      const res = await fetch(`/api/repositories/${repository.id}`, { method: "DELETE" });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        setError(e.error ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/repositories");
      router.refresh();
    });
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-secondary/40 px-2 py-1 text-xs hover:bg-secondary"
        >
          <Pencil className="size-3" /> Edit
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs text-muted-foreground hover:text-state-blocked hover:border-state-blocked/60"
        >
          <Trash2 className="size-3" /> Delete
        </button>
        {error && <span className="text-[11px] text-state-blocked">{error}</span>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Repository name"
        className="w-full rounded-sm border border-border/60 bg-background px-2 py-1.5 text-sm font-medium outline-none focus:border-foreground/40"
      />
      <input
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        placeholder="Local path"
        className="w-full rounded-sm border border-border/60 bg-background px-2 py-1.5 text-xs font-mono outline-none focus:border-foreground/40"
      />
      <input
        value={remote}
        onChange={(e) => setRemote(e.target.value)}
        placeholder="Remote URL"
        className="w-full rounded-sm border border-border/60 bg-background px-2 py-1.5 text-xs font-mono outline-none focus:border-foreground/40"
      />
      <div className="flex gap-2">
        <input
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="default branch"
          className="w-32 rounded-sm border border-border/60 bg-background px-2 py-1 text-xs font-mono outline-none focus:border-foreground/40"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="description"
          className="flex-1 rounded-sm border border-border/60 bg-background px-2 py-1 text-xs outline-none focus:border-foreground/40"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className={cn(
            "inline-flex items-center gap-1 rounded-md bg-foreground text-background px-3 py-1 text-xs font-medium",
            "hover:opacity-90 disabled:opacity-40"
          )}
        >
          {pending ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
          Save
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-[11px] text-state-blocked">{error}</p>}
    </form>
  );
}
