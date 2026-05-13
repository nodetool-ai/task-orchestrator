import { auth } from "@/auth";
import * as chat from "@/lib/chat";
import { ChatSidebar } from "@/components/chat/chat-sidebar";

export const dynamic = "force-dynamic";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const userId = session?.user?.id ? Number(session.user.id) : null;
  const chats = chat.listChats(userId);
  // Serialize dates so the client component receives plain JSON.
  const serializable = chats.map((c) => ({
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt.toISOString(),
  }));

  return (
    <div className="-my-8 h-[calc(100vh-3rem-1px)] flex">
      <ChatSidebar chats={serializable} />
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden">{children}</div>
    </div>
  );
}
