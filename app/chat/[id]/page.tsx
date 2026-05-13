import { notFound } from "next/navigation";
import { auth } from "@/auth";
import * as chat from "@/lib/chat";
import * as repo from "@/lib/repo";
import { ChatThread } from "@/components/chat/chat-thread";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const chatId = Number(id);
  if (!Number.isFinite(chatId)) notFound();

  const session = await auth();
  const userId = session?.user?.id ? Number(session.user.id) : null;
  const row = chat.getChat(chatId, userId);
  if (!row) notFound();

  const messages = chat.listMessages(row.id);
  const { cwd } = chat.resolveChatCwd(row);
  const repositories = repo.listRepositories().map((r) => ({
    id: r.id,
    name: r.name,
    localPath: r.localPath,
  }));

  return (
    <ChatThread
      chat={row}
      initialMessages={messages}
      userEmail={session?.user?.email ?? null}
      repoRoot={cwd}
      defaultModel={chat.getDefaultModel()}
      repositories={repositories}
    />
  );
}
