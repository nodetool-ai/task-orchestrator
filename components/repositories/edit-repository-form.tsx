"use client";

import { Spinner } from "@/components/ui/spinner";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Save, Trash2 } from "lucide-react";
import type { RepositoryRow } from "@/lib/types";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/dialog-provider";
import { ErrorText } from "@/components/ui/error-text";
import { FormPanel } from "@/components/ui/form-panel";

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
      try {
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
      } catch (err) {
        setError(describe(err));
      }
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
      try {
        const res = await fetch(`/api/repositories/${repository.id}`, { method: "DELETE" });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        router.push("/repositories");
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          onClick={() => setOpen(true)}
          className="bg-secondary/40 text-foreground enabled:hover:bg-secondary"
        >
          <Pencil className="size-3" /> Edit
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={remove}
          disabled={pending}
          className="enabled:hover:text-state-blocked enabled:hover:border-state-blocked/60"
        >
          <Trash2 className="size-3" /> Delete
        </Button>
        <ErrorText className="text-[11px]">{error}</ErrorText>
      </div>
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      <Input
        autoFocus
        uiSize="sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Repository name"
        className="text-sm font-medium"
      />
      <Input
        uiSize="sm"
        mono
        value={localPath}
        onChange={(e) => setLocalPath(e.target.value)}
        placeholder="Local path"
      />
      <Input
        uiSize="sm"
        mono
        value={remote}
        onChange={(e) => setRemote(e.target.value)}
        placeholder="Remote URL"
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
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner className="size-3" /> : <Save className="size-3" />}
          Save
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ErrorText className="text-[11px]">{error}</ErrorText>
    </FormPanel>
  );
}
