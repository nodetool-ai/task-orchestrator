import { notFound } from "next/navigation";
import { auth } from "@/auth";
import * as chat from "@/lib/chat";
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
  return (
    <ChatThread
      chat={row}
      initialMessages={messages}
      userEmail={session?.user?.email ?? null}
      repoRoot={chat.getRepoRoot()}
      defaultModel={chat.getDefaultModel()}
    />
  );
}
