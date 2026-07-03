"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

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
    <Button size="md" onClick={create} disabled={creating} className="gap-2 px-4">
      <Plus className="size-4" />
      {creating ? "Creating…" : "Start a chat"}
    </Button>
  );
}
