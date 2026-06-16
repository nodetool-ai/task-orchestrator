// lib/terminal-ws.ts
//
// Standalone WebSocket server (port TASK_ORCH_TERMINAL_WS_PORT, default 3030)
// that bridges authenticated browser clients to tmux pane streams.
//
// Protocol:
//   Server → Client: binary frames (raw terminal bytes — xterm.js writes them)
//   Client → Server: JSON text frames
//     {type:"input", data: string}          — forward keystrokes to tmux
//     {type:"resize", cols:number, rows:number} — resize the tmux window
//
// Auth: short-lived HMAC token from GET /api/runs/[id]/terminal, passed as
// ?token= query parameter on the WebSocket handshake URL.

import { createServer as createHttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { verifyToken } from "./terminal-auth";
import {
  attachToSession,
  isSessionAlive,
  resizeSession,
  sendInput,
} from "./terminal-bridge";
import * as runs from "./runs";

const DEFAULT_PORT = 3030;

declare global {
  // eslint-disable-next-line no-var
  var __terminalWsServer: WebSocketServer | undefined;
  // eslint-disable-next-line no-var
  var __terminalWsPort: number | undefined;
}

/**
 * Start the WebSocket server on first call; subsequent calls are no-ops.
 * Returns the port the server is listening on.
 */
export function ensureTerminalWsServer(): number {
  if (globalThis.__terminalWsServer) {
    return globalThis.__terminalWsPort ?? DEFAULT_PORT;
  }

  const port = parseInt(
    process.env.TASK_ORCH_TERMINAL_WS_PORT ?? String(DEFAULT_PORT),
    10
  );

  const wss = new WebSocketServer({ port });
  globalThis.__terminalWsServer = wss;
  globalThis.__terminalWsPort = port;

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    void handleConnection(ws, req).catch((err: unknown) => {
      try {
        ws.close(
          1011,
          err instanceof Error ? err.message : "internal error"
        );
      } catch {
        // ignore
      }
    });
  });

  wss.on("error", (err: Error) => {
    console.error("[terminal-ws] server error:", err.message);
  });

  console.log(`[terminal-ws] listening on ws://localhost:${port}`);
  return port;
}

async function handleConnection(
  ws: WebSocket,
  req: IncomingMessage
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token");

  if (!token) {
    ws.close(1008, "missing token");
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    ws.close(1008, "invalid or expired token");
    return;
  }

  const run = runs.get(payload.runId);
  if (!run || !run.tmuxSession) {
    ws.close(1008, "run not found or no tmux session");
    return;
  }

  const alive = await isSessionAlive(run.tmuxSession);
  if (!alive) {
    // Session ended — notify the client cleanly so it can show an overlay.
    ws.send(
      Buffer.from(
        "\r\n\x1b[33m[task-orchestrator] tmux session ended\x1b[0m\r\n",
        "utf8"
      )
    );
    ws.close(1001, "tmux session ended");
    return;
  }

  const tmuxSession = run.tmuxSession;

  let detach: (() => Promise<void>) | null = null;

  const onData = (data: Buffer) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  };

  try {
    detach = await attachToSession(tmuxSession, onData);
  } catch (err) {
    ws.close(
      1011,
      err instanceof Error ? err.message : "bridge error"
    );
    return;
  }

  ws.on("message", (raw: Buffer | string) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }

    if (msg.type === "input" && typeof msg.data === "string") {
      void sendInput(tmuxSession, msg.data).catch(() => {});
    } else if (
      msg.type === "resize" &&
      typeof msg.cols === "number" &&
      typeof msg.rows === "number"
    ) {
      void resizeSession(tmuxSession, msg.cols, msg.rows).catch(() => {});
    }
  });

  const cleanup = () => {
    void detach?.().catch(() => {});
    detach = null;
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
