"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Plus, MessageSquare, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/dialog-provider";

export interface SidebarChat {
  id: number;
  title: string;
  updatedAt: string;
}

interface Props {
  chats: SidebarChat[];
}

const DAY = 86_400_000;

function bucketize(chats: SidebarChat[]): Array<{ label: string; items: SidebarChat[] }> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets = {
    today: [] as SidebarChat[],
    yesterday: [] as SidebarChat[],
    week: [] as SidebarChat[],
    older: [] as SidebarChat[],
  };
  for (const c of chats) {
    const ts = new Date(c.updatedAt).getTime();
    if (ts >= startOfDay) buckets.today.push(c);
    else if (ts >= startOfDay - DAY) buckets.yesterday.push(c);
    else if (ts >= startOfDay - 7 * DAY) buckets.week.push(c);
    else buckets.older.push(c);
  }
  return [
    { label: "Today", items: buckets.today },
    { label: "Yesterday", items: buckets.yesterday },
    { label: "Previous 7 days", items: buckets.week },
    { label: "Older", items: buckets.older },
  ].filter((g) => g.items.length > 0);
}

export function ChatSidebar({ chats }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    if (!query.trim()) return chats;
    const q = query.toLowerCase();
    return chats.filter((c) => c.title.toLowerCase().includes(q));
  }, [chats, query]);

  const groups = useMemo(() => bucketize(filtered), [filtered]);
  const activeId = pathname.startsWith("/chat/")
    ? Number(pathname.split("/")[2])
    : null;

  async function newChat() {
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

  async function deleteChat(id: number) {
    if (!(await confirm({ message: "Delete this chat?", confirmLabel: "Delete", tone: "danger" })))
      return;
    const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    if (activeId === id) {
      startTransition(() => {
        router.push("/chat");
        router.refresh();
      });
    } else {
      router.refresh();
    }
  }

  return (
    <aside className="w-64 shrink-0 border-r border-border/60 bg-card/40 flex flex-col overflow-hidden">
      <div className="p-3 space-y-2 border-b border-border/60">
        <Button onClick={newChat} disabled={creating} className="w-full gap-2">
          <Plus className="size-3.5" />
          {creating ? "Creating…" : "New chat"}
        </Button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            uiSize="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            className="rounded-md bg-background/60 pl-7 pr-2"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-4">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {query ? "No matching chats." : "No chats yet. Start one!"}
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="space-y-1">
              <div className="px-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                {g.label}
              </div>
              <ul className="space-y-0.5">
                {g.items.map((c) => {
                  const active = activeId === c.id;
                  return (
                    <li key={c.id} className="group relative">
                      <Link
                        href={`/chat/${c.id}`}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                          active
                            ? "bg-secondary text-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                        )}
                      >
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="truncate flex-1">{c.title}</span>
                      </Link>
                      <button
                        type="button"
                        aria-label="Delete chat"
                        onClick={(e) => {
                          e.preventDefault();
                          deleteChat(c.id);
                        }}
                        className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:inline-flex p-1 rounded text-muted-foreground hover:text-state-blocked hover:bg-muted"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </nav>
    </aside>
  );
}
