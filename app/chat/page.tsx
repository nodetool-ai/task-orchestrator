import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import * as repo from "@/lib/repo";
import { listRuns } from "@/lib/runs";
import { relativeDate } from "@/lib/utils";
import { NewChatBox } from "@/components/new-chat-box";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const personas = repo.listPersonas().map((p) => ({
    id: p.id,
    name: p.name,
    modelProvider: p.modelProvider,
    modelId: p.modelId,
  }));
  const repositories = repo.listRepositories().map((r) => ({ id: r.id, name: r.name }));
  const chatRuns = listRuns({}).filter((r) => r.goal === "<chat>").slice(0, 30);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Chat</h1>
          <p className="text-sm text-muted-foreground">
            Free-form conversation with the agent. Each chat is its own run, listed below.
          </p>
        </div>
        <NewChatBox personas={personas} repositories={repositories} />
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
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {r.status}
                  </span>
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {relativeDate(r.startedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
