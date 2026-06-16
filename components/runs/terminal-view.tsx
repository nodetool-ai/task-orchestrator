"use client";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface Props {
  runId: number;
  tmuxSession: string;
}

type Status = "connecting" | "connected" | "ended" | "error";

export function TerminalView({ runId, tmuxSession }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let cleanup: (() => void) | undefined;

    async function connect() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: '"Fira Code", "Cascadia Code", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        theme: {
          background: "#0d0d0d",
          foreground: "#d4d4d4",
          cursor: "#aeafad",
          selectionBackground: "#264f78",
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      // Fetch token
      let token: string, wsUrl: string;
      try {
        const res = await fetch(`/api/runs/${runId}/terminal`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { token: string; wsUrl: string };
        token = data.token;
        wsUrl = data.wsUrl;
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          setErrorMsg(
            err instanceof Error ? err.message : "Failed to get terminal token"
          );
        }
        term.dispose();
        return;
      }

      if (disposed) {
        term.dispose();
        return;
      }

      ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (!disposed) setStatus("connected");
        // Send initial size
        ws!.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data));
        } else if (typeof e.data === "string") {
          term.write(e.data);
        }
      };

      ws.onclose = () => {
        if (!disposed) setStatus("ended");
      };

      ws.onerror = () => {
        if (!disposed) {
          setStatus("error");
          setErrorMsg("WebSocket connection failed");
        }
      };

      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      // Resize observer: re-fit xterm and notify server
      const ro = new ResizeObserver(() => {
        fit.fit();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
          );
        }
      });
      ro.observe(containerRef.current!);

      cleanup = () => {
        ro.disconnect();
        term.dispose();
      };
    }

    connect().catch((err: unknown) => {
      if (!disposed) {
        setStatus("error");
        setErrorMsg(
          err instanceof Error ? err.message : "Terminal initialisation failed"
        );
      }
    });

    return () => {
      disposed = true;
      ws?.close();
      ws = null;
      cleanup?.();
    };
  }, [runId]);

  return (
    <div className="flex flex-col border-t border-border/60">
      {/* Toolbar */}
      <div className="flex items-center gap-2 bg-[#141414] border-b border-border/30 px-3 py-1.5">
        <span className="text-[11px] font-mono text-muted-foreground/70 truncate">
          {tmuxSession}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 text-[10px] font-mono tabular-nums",
            status === "connected" && "text-green-500/80",
            status === "connecting" && "text-yellow-500/80",
            (status === "ended" || status === "error") && "text-muted-foreground/50"
          )}
        >
          {status}
        </span>
      </div>

      {errorMsg && (
        <div className="bg-[#0d0d0d] px-3 py-2 text-[11px] font-mono text-rose-400">
          {errorMsg}
        </div>
      )}

      {/* xterm container */}
      <div
        ref={containerRef}
        className="bg-[#0d0d0d]"
        style={{ height: "320px" }}
      />

      {status === "ended" && (
        <div className="bg-[#141414] px-3 py-2 text-center text-[11px] font-mono text-muted-foreground/60">
          tmux session ended
        </div>
      )}
    </div>
  );
}
