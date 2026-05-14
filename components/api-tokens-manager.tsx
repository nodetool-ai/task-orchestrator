"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Copy, Check, KeyRound } from "lucide-react";
import { relativeDate } from "@/lib/utils";

interface TokenSummary {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface CreatedToken {
  id: number;
  name: string;
  prefix: string;
  token: string;
}

export function ApiTokensManager() {
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/tokens");
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { tokens: TokenSummary[] };
      setTokens(body.tokens);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      const t = (await res.json()) as CreatedToken;
      setCreated(t);
      setNewName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: number) {
    if (!confirm("Revoke this token? Clients using it will start failing.")) return;
    const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    await load();
  }

  async function copyTokenToClipboard() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers — fall back to selection.
    }
  }

  return (
    <div className="space-y-6">
      {/* Created-token banner */}
      {created && (
        <div className="rounded-lg border border-state-progress/40 bg-state-progress/10 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4 text-state-progress" />
            New token <code className="font-mono">{created.name}</code>
          </div>
          <p className="text-xs text-muted-foreground">
            This is the only time the secret is shown. Copy it now or paste
            one of the ready-made snippets below.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded-md border border-border/60 bg-background px-3 py-2 font-mono text-xs break-all">
              {created.token}
            </code>
            <button
              type="button"
              onClick={copyTokenToClipboard}
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs hover:bg-muted/40"
            >
              {copied ? (
                <Check className="size-3.5 text-state-done" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="inline-flex items-center rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs hover:bg-muted/40"
            >
              Dismiss
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-3 pt-1">
            <SnippetBlock
              label="Claude Code (CLI):"
              text={`claude mcp add --transport http \\
  task-orchestrator \\
  ${origin()}/api/mcp \\
  --header "Authorization: Bearer ${created.token}"`}
            />
            <SnippetBlock
              label="Claude Desktop:"
              text={`{
  "mcpServers": {
    "task-orchestrator": {
      "type": "http",
      "url": "${origin()}/api/mcp",
      "headers": { "Authorization": "Bearer ${created.token}" }
    }
  }
}`}
            />
            <SnippetBlock
              label="Cursor (~/.cursor/mcp.json):"
              text={`{
  "mcpServers": {
    "task-orchestrator": {
      "url": "${origin()}/api/mcp",
      "headers": { "Authorization": "Bearer ${created.token}" }
    }
  }
}`}
            />
          </div>
        </div>
      )}

      {/* New token form */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <h2 className="text-sm font-medium">New token</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="e.g. claude-desktop"
            disabled={creating}
            className="flex-1 min-w-[12rem] rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10 transition-colors disabled:opacity-50"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating || !newName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-sm font-medium hover:bg-foreground/90 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Generate
          </button>
        </div>
        {error && <p className="text-xs text-state-blocked">{error}</p>}
      </div>

      {/* Existing tokens table */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Existing tokens</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card/40">
            {tokens.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <KeyRound className="size-3.5 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium truncate">{t.name}</span>
                    <code className="text-[11px] text-muted-foreground">
                      tot_{t.prefix}…
                    </code>
                    {t.revokedAt && (
                      <span className="text-[10px] uppercase tracking-wide text-state-blocked">
                        revoked
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground tabular-nums">
                    Created {relativeDate(new Date(t.createdAt))}
                    {t.lastUsedAt && (
                      <> · Last used {relativeDate(new Date(t.lastUsedAt))}</>
                    )}
                  </div>
                </div>
                {!t.revokedAt && (
                  <button
                    type="button"
                    onClick={() => revoke(t.id)}
                    className="inline-flex items-center gap-1 rounded-md border border-state-blocked/30 bg-state-blocked/10 px-2 py-0.5 text-[11px] text-state-blocked hover:bg-state-blocked/15"
                  >
                    <Trash2 className="size-3" /> Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function origin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "https://tasks.nodetool.ai";
}

function SnippetBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // older browsers — fall back silently
    }
  }
  return (
    <div className="rounded-md border border-border/60 bg-background/60 p-3 text-xs space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[10px] hover:bg-muted/40"
        >
          {copied ? (
            <Check className="size-3 text-state-done" />
          ) : (
            <Copy className="size-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground select-all">
        {text}
      </pre>
    </div>
  );
}
