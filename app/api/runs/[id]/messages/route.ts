import { type NextRequest } from "next/server";
import { resolveApiActor, unauthorizedResponse } from "@/lib/api-auth";
import * as runs from "@/lib/runs";
import { buildMergePrompt } from "@/lib/run-templates";

export const dynamic = "force-dynamic";

// POST a user message and stream the agent's reply as SSE.
// Each frame is a `runs.AppendStreamEvent`. The stream closes after a
// `done` or `error` event. Disconnecting cancels the SDK call via the
// abort controller forwarded to runs.append().
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return new Response("Bad id", { status: 400 });
  }
  const run = await runs.get(runId);
  if (!run) return new Response("Not found", { status: 404 });

  // Bearer (terminal cockpit) or session cookie (browser); a presented token
  // that does not verify is a 401 (tui T-tui-11).
  const actor = await resolveApiActor(req);
  if (!actor.ok) return unauthorizedResponse();
  const author = actor.actor?.email ?? "chat";

  let body: { text?: string; resolveMergeBaseRef?: string | null };
  try {
    body = (await req.json()) as { text?: string; resolveMergeBaseRef?: string | null };
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  // The Resolve-merge button posts a base-ref hint instead of free text; the
  // canonical merge prompt is built here so it stays a single source of truth.
  const text = (
    "resolveMergeBaseRef" in body
      ? buildMergePrompt(body.resolveMergeBaseRef ?? null)
      : body.text ?? ""
  ).trim();
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
        // sendMessageToRun persists the message and, in the containerized deploy,
        // dispatches/relays it through a worker (the root server can't run agent
        // turns); in dev it falls back to in-process append(). Same frame contract.
        for await (const event of runs.sendMessageToRun({
          runId,
          role: "user",
          text,
          author,
          abort,
        })) {
          send(event);
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
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
