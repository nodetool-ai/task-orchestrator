import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import * as runs from "@/lib/runs";
import { signToken } from "@/lib/terminal-auth";
import { ensureTerminalWsServer } from "@/lib/terminal-ws";

export const dynamic = "force-dynamic";

/**
 * GET /api/runs/[id]/terminal
 *
 * Mints a short-lived (60 s) HMAC token and returns the WebSocket URL for
 * the live terminal bridge. Only available for running claude_cli runs that
 * have an active tmux session.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const runId = parseInt(id, 10);
  if (Number.isNaN(runId)) {
    return NextResponse.json({ error: "Invalid run id" }, { status: 400 });
  }

  const run = runs.get(runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (run.harness !== "claude_cli" || !run.tmuxSession) {
    return NextResponse.json(
      { error: "No terminal available for this run" },
      { status: 400 }
    );
  }

  const port = ensureTerminalWsServer();
  const token = signToken(runId);

  return NextResponse.json({
    token,
    wsUrl: `ws://localhost:${port}`,
  });
}
