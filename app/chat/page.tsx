import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";
import { auth } from "@/auth";
import * as chat from "@/lib/chat";
import { NewChatCta } from "@/components/chat/new-chat-cta";

export const dynamic = "force-dynamic";

export default async function ChatIndex() {
  const session = await auth();
  const userId = session?.user?.id ? Number(session.user.id) : null;
  const chats = chat.listChats(userId);
  if (chats.length > 0) {
    redirect(`/chat/${chats[0].id}`);
  }
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div className="max-w-md space-y-4">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border/60 bg-card/60">
          <Sparkles className="size-5 text-state-review" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Chat with Claude</h1>
        <p className="text-sm text-muted-foreground">
          A persistent Claude Agent SDK interface scoped to your account. Each thread keeps its
          SDK session id so Claude remembers context across turns.
        </p>
        <NewChatCta />
      </div>
    </div>
  );
}
