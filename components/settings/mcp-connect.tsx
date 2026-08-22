"use client";

import * as React from "react";
import { Check, Copy, Download, ExternalLink, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  MCP_CLIENTS,
  MCP_TOKEN_PLACEHOLDER,
  mcpEndpoint,
  mcpJsonFile,
  type McpConnection,
} from "@/lib/mcp-clients";

/**
 * The onboarding half of the API-tokens tab: pick a client, copy a config
 * that already has the endpoint and the token in it, then prove it works
 * with "Test connection" (a real tools/list call against /api/mcp).
 *
 * `token` is the plaintext from a just-created token. It is null whenever
 * the secret is not in hand — snippets then carry a placeholder, and the
 * live actions (deep link, download, test) are disabled rather than
 * silently handing out a config that cannot authenticate.
 */
export function McpConnect({ token }: { token: string | null }) {
  const [clientId, setClientId] = React.useState(MCP_CLIENTS[0].id);
  const client = MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0];

  const origin = useOrigin();
  const conn: McpConnection = { origin, token: token ?? MCP_TOKEN_PLACEHOLDER };
  const live = token !== null;

  function download() {
    const blob = new Blob([mcpJsonFile(conn)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".mcp.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Plug className="size-4 text-muted-foreground" />
          Connect a client
        </h2>
        <code className="rounded border border-border/60 bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          POST {mcpEndpoint(conn.origin)}
        </code>
      </div>

      <div role="tablist" aria-label="MCP clients" className="flex flex-wrap gap-1">
        {MCP_CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === clientId}
            onClick={() => setClientId(c.id)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              c.id === clientId
                ? "border-state-progress/40 bg-state-progress/10 text-foreground"
                : "border-border/60 bg-background/60 text-muted-foreground hover:bg-muted/40"
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">{client.hint}</p>

      <Snippet text={client.snippet(conn)} />

      <div className="flex flex-wrap items-center gap-2">
        {client.deepLink && (
          <Button
            variant="outline"
            size="xs"
            disabled={!live}
            onClick={() => {
              const link = client.deepLink?.(conn);
              if (link) window.location.href = link;
            }}
          >
            <ExternalLink className="size-3" /> Install in {client.label}
          </Button>
        )}
        <Button variant="outline" size="xs" onClick={download} disabled={!live}>
          <Download className="size-3" /> Download .mcp.json
        </Button>
        <TestConnection token={token} />
      </div>

      {!live && (
        <p className="text-xs text-muted-foreground">
          Generate a token below to fill these snippets in with the real
          secret — it is shown once, and the one-click actions unlock while
          it is on screen.
        </p>
      )}
    </div>
  );
}

/** Same-origin tools/list call, so "does my token work?" is one click. */
function TestConnection({ token }: { token: string | null }) {
  const [state, setState] = React.useState<
    { kind: "idle" | "running" } | { kind: "ok"; tools: number } | { kind: "err"; message: string }
  >({ kind: "idle" });

  async function run() {
    if (!token) return;
    setState({ kind: "running" });
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      if (!res.ok) {
        setState({ kind: "err", message: `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as {
        result?: { tools?: unknown[] };
        error?: { message?: string };
      };
      if (body.error) {
        setState({ kind: "err", message: body.error.message ?? "JSON-RPC error" });
        return;
      }
      setState({ kind: "ok", tools: body.result?.tools?.length ?? 0 });
    } catch (err) {
      setState({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="outline" size="xs" onClick={run} disabled={!token || state.kind === "running"}>
        {state.kind === "running" ? <Spinner className="size-3" /> : <Check className="size-3" />}
        Test connection
      </Button>
      {state.kind === "ok" && (
        <span className="text-xs text-state-done">
          Authenticated · {state.tools} tools available
        </span>
      )}
      {state.kind === "err" && (
        <span className="text-xs text-state-blocked">{state.message}</span>
      )}
    </span>
  );
}

function Snippet({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers — the block is selectable, so copy by hand.
    }
  }
  return (
    <div className="relative">
      <CodeBlock tone="muted" selectable className="pr-20">
        {text}
      </CodeBlock>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted/40"
      >
        {copied ? (
          <Check className="size-3 text-state-done" />
        ) : (
          <Copy className="size-3" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Whatever host the app is actually served on — never a hardcoded guess. */
function useOrigin(): string {
  const [origin, setOrigin] = React.useState("https://tasks.nodetool.ai");
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location?.origin) {
      setOrigin(window.location.origin);
    }
  }, []);
  return origin;
}
