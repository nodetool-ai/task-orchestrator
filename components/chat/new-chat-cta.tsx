"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

export function NewChatCta() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  async function create() {
    setCreating(true);
    try {
      const res = await fetch("/api/chats", { method: "POST" });
      if (!res.ok) return;
      const created = (await res.json()) as { id: number };
      startTransition(() => {
        router.push(`/chat/${created.id}`);
        router.refresh();
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <button
      type="button"
      onClick={create}
      disabled={creating}
      className="inline-flex items-center gap-2 rounded-md bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
    >
      <Plus className="size-4" />
      {creating ? "Creating…" : "Start a chat"}
    </button>
  );
}
