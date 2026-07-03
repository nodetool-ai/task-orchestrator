"use client";

import { Spinner } from "@/components/ui/spinner";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ErrorText } from "@/components/ui/error-text";
import { FormPanel } from "@/components/ui/form-panel";

export function AddNoteForm({
  taskId,
  defaultAuthor,
}: {
  taskId: string;
  defaultAuthor?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [author, setAuthor] = useState(defaultAuthor ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || !author.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: body.trim(), author: author.trim() }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        setBody("");
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
        <Plus className="size-3" /> Add note
      </button>
    );
  }

  return (
    <FormPanel onSubmit={submit}>
      <Textarea
        autoFocus
        rows={2}
        uiSize="sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setBody("");
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
        placeholder="What happened?"
        className="resize-none text-sm"
      />
      <div className="flex items-center gap-2">
        <Input
          uiSize="xs"
          mono
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          placeholder="author"
          className="w-32"
        />
        <Button
          type="submit"
          size="xs"
          disabled={pending || !body.trim() || !author.trim()}
          className="ml-auto"
        >
          {pending && <Spinner className="size-3" />}
          Add
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            setOpen(false);
            setBody("");
          }}
        >
          Cancel
        </Button>
      </div>
      <ErrorText className="text-[11px]">{error}</ErrorText>
    </FormPanel>
  );
}
