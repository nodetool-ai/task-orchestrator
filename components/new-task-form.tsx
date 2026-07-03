"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PersonaPicker,
  type PersonaOption,
} from "@/components/pickers/persona-picker";
import {
  RepositoryPicker,
  type RepositoryOption,
} from "@/components/pickers/repository-picker";
import { TagsInput } from "@/components/pickers/tags-input";
import { AssigneePicker } from "@/components/pickers/assignee-picker";
import { ErrorText } from "@/components/ui/error-text";

type RepoOption = RepositoryOption;

interface NewTaskFormProps {
  planId: string;
  /** Repos attached to the plan. When more than one, a selector appears. */
  repoOptions?: RepoOption[];
}

export function NewTaskForm({ planId, repoOptions = [] }: NewTaskFormProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [assignee, setAssignee] = useState("");
  const [repoId, setRepoId] = useState(repoOptions[0]?.id ?? "");
  const [personaId, setPersonaId] = useState("implementor");
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d: { personas: PersonaOption[] }) => setPersonas(d.personas))
      .catch(() => {});
  }, []);

  const reset = () => {
    setTitle("");
    setCriteria("");
    setTags([]);
    setAssignee("");
    setRepoId(repoOptions[0]?.id ?? "");
    setPersonaId("implementor");
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (repoOptions.length > 1 && !repoId) {
      setError("Pick which repository this task targets.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: planId,
            title: title.trim(),
            assignee: assignee.trim() || undefined,
            repoId: repoId || undefined,
            personaId: personaId || undefined,
            criteria: criteria
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            tags,
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        reset();
        setOpen(false);
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
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3" /> New task
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3">
      <Input
        autoFocus
        uiSize="sm"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        className="text-sm font-medium"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            setOpen(false);
          }
        }}
      />
      <Textarea
        rows={3}
        uiSize="sm"
        value={criteria}
        onChange={(e) => setCriteria(e.target.value)}
        placeholder={"Acceptance criteria, one per line"}
        className="resize-none"
      />
      <div className="flex flex-wrap items-center gap-2">
        <AssigneePicker value={assignee} onChange={setAssignee} size="compact" />
        <PersonaPicker
          personas={personas}
          value={personaId}
          onChange={setPersonaId}
          size="compact"
        />
        {repoOptions.length > 1 && (
          <RepositoryPicker
            repositories={repoOptions}
            value={repoId}
            onChange={setRepoId}
            emptyLabel="repo…"
            size="compact"
          />
        )}
        <div className="flex-1 min-w-[8rem]">
          <TagsInput
            value={tags}
            onChange={setTags}
            placeholder="tags…"
            size="compact"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !title.trim()}>
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
