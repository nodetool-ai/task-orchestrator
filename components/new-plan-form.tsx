"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { describe } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TagsInput } from "@/components/pickers/tags-input";

export function NewPlanForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setBody("");
    setTags([]);
    setOwner("");
    setError(null);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            body: body.trim() || undefined,
            owner: owner.trim() || undefined,
            tags,
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
        router.push(`/plans/${created.id}`);
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-3.5" /> New plan
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border border-border/60 bg-card/30 px-3 py-3">
      <Input
        autoFocus
        uiSize="sm"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Plan title"
        className="text-sm font-medium"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            reset();
            setOpen(false);
          }
        }}
      />
      <Textarea
        rows={4}
        uiSize="sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Goal / approach (markdown)"
        className="resize-none"
      />
      <div className="flex items-center gap-2">
        <Input
          uiSize="xs"
          mono
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="owner"
          className="w-28"
        />
        <div className="flex-1 min-w-[8rem]">
          <TagsInput
            value={tags}
            onChange={setTags}
            placeholder="tags…"
            size="compact"
          />
        </div>
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
      {error && <p className="text-[11px] text-state-blocked">{error}</p>}
    </form>
  );
}
