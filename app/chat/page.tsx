import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import * as repo from "@/lib/repo";
import { listRuns } from "@/lib/runs";
import { getDefaultModel } from "@/lib/chat";
import { relativeDate } from "@/lib/utils";
import { NewChatBox } from "@/components/new-chat-box";
import { SessionStatusPill } from "@/components/session-status-pill";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const repositories = repo.listRepositories().map((r) => ({ id: r.id, name: r.name }));
  const chatRuns = listRuns({}).filter((r) => r.goal === "<chat>").slice(0, 30);
  const defaultModel = getDefaultModel();

  return (
    <div style={{ padding: "20px 20px 80px", maxWidth: 1480, margin: "0 auto" }}>
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Chat</h1>
          <p className="text-sm text-muted-foreground">
            Free-form conversation with the agent. Each chat is its own run, listed below.
          </p>
        </div>
        <NewChatBox defaultModel={defaultModel} repositories={repositories} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold tracking-tight">Recent chats</h2>
        {chatRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No chats yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card/40">
            {chatRuns.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/runs/${r.id}`}
                  className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors"
                >
                  <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-sm flex-1 truncate">
                    {r.title ?? `Chat #${r.id}`}
                  </span>
                  <SessionStatusPill status={r.status} className="shrink-0" />
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {relativeDate(r.startedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
    </div>
  );
}
