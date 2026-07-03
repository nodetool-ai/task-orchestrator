"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorText } from "@/components/ui/error-text";

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
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> New repository
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3">
      <Input
        autoFocus
        uiSize="sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Repository name (e.g. nodetool)"
        className="text-sm font-medium"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            setOpen(false);
          }
        }}
      />
      <Input
        uiSize="sm"
        mono
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        placeholder="Local path (e.g. /home/claude/nodetool)"
      />
      <Input
        uiSize="sm"
        mono
        value={remote}
        onChange={(e) => setRemote(e.target.value)}
        placeholder="Remote URL (e.g. git@github.com:org/repo.git)"
      />
      <div className="flex gap-2">
        <Input
          uiSize="xs"
          mono
          value={defaultBranch}
          onChange={(e) => setDefaultBranch(e.target.value)}
          placeholder="default branch"
          className="w-32"
        />
        <Input
          uiSize="xs"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="description"
          className="flex-1 w-auto"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending && <Loader2 className="size-3 animate-spin" />}
          Create
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </div>
      <ErrorText className="text-[11px]">{error}</ErrorText>
    </form>
  );
}
