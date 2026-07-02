"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { cn, describe } from "@/lib/utils";

export function NewRepositoryForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [remote, setRemote] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [description, setDescription] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setRemote("");
    setLocalPath("");
    setDefaultBranch("main");
    setDescription("");
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/repositories", {
          method: "POST",
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
        const created = await res.json();
        reset();
        setOpen(false);
        router.push(`/repositories/${created.id}`);
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90"
      >
        <Plus className="size-3.5" /> New repository
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Repository name (e.g. nodetool)"
        className="w-full rounded-sm border border-border/60 bg-background px-2 py-1.5 text-sm font-medium outline-none focus:border-foreground/40"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            setOpen(false);
          }
        }}
      />
      <input
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        placeholder="Local path (e.g. /home/claude/nodetool)"
        className="w-full rounded-sm border border-border/60 bg-background px-2 py-1.5 text-xs font-mono outline-none focus:border-foreground/40"
      />
      <input
        value={remote}
        onChange={(e) => setRemote(e.target.value)}
        placeholder="Remote URL (e.g. git@github.com:org/repo.git)"
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
          disabled={pending || !name.trim()}
          className={cn(
            "inline-flex items-center gap-1 rounded-md bg-foreground text-background px-3 py-1 text-xs font-medium",
            "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          {pending && <Loader2 className="size-3 animate-spin" />}
          Create
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-[11px] text-state-blocked">{error}</p>}
    </form>
  );
}
