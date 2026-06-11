import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import * as runs from "@/lib/runs";
import { isTerminalStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Claude Code lifecycle-hook callback for Claude-CLI harness runs. The
// hooks injected via --settings (lib/claude-cli.ts buildHookSettings) curl
// their stdin payload here verbatim; payload.hook_event_name says which
// event fired. Authenticated by the per-run bearer token, not a browser
// session (see the middleware exemption). Must respond fast — the worker
// in lib/runs.ts performs the actual PR/completion flow.

const hookPayloadSchema = z
  .object({
    hook_event_name: z.string(),
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    reason: z.string().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .passthrough();

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }

  const auth = runs.getHookAuth(runId);
  if (!auth || auth.harness !== "claude_cli" || !auth.hookToken) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const header = req.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!provided || !tokenMatches(provided, auth.hookToken)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Late callbacks after a restart/reap land on a terminal run — ack and
  // drop so the (long-dead) worker state isn't poked.
  if (isTerminalStatus(auth.status) && auth.status !== "idle") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  let payload: z.infer<typeof hookPayloadSchema>;
  try {
    payload = hookPayloadSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Bad payload" }, { status: 400 });
  }

  runs.handleClaudeHook(runId, payload);
  return NextResponse.json({ ok: true });
}
