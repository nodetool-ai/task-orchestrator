import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import * as chat from "@/lib/chat";

export const dynamic = "force-dynamic";

// POST a user message and stream the agent's reply as SSE.
// Each event is a `ChatStreamEvent` from lib/chat. The stream closes after a
// `done` or `error` event. Disconnecting cancels the SDK call.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const chatId = Number(id);
  const session = await auth();
  const uid = session?.user?.id ? Number(session.user.id) : null;
  const author = session?.user?.email ?? "chat";
  const existing = await chat.getChat(chatId, uid);
  if (!existing) {
    return new Response("Not found", { status: 404 });
  }

  let body: { text?: string };
  try {
    body = (await req.json()) as { text?: string };
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return new Response("Empty message", { status: 400 });

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        for await (const event of chat.runChat({ chatId, userText: text, abort, author })) {
          send(event);
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
