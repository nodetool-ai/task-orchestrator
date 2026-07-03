"use client";

import { Spinner } from "@/components/ui/spinner";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { describe } from "@/lib/utils";
import { ErrorText } from "@/components/ui/error-text";

export function AddCriterionForm({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}/criteria`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: text.trim() }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          setError(e.error ?? `HTTP ${res.status}`);
          return;
        }
        setText("");
        router.refresh();
      } catch (err) {
        setError(describe(err));
      }
    });
  };

  return (
    <form onSubmit={submit} className="flex items-center gap-2 pt-1">
      <Plus className="size-3.5 text-muted-foreground shrink-0" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add an acceptance criterion"
        className="flex-1 rounded-sm bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground focus:bg-muted/40"
      />
      {pending && <Spinner className="size-3 text-muted-foreground" />}
      <ErrorText className="text-[11px]">{error}</ErrorText>
    </form>
  );
}
