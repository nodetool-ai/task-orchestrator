"use client";

import { Spinner } from "@/components/ui/spinner";
import { useEffect, useState } from "react";
import { Plus, Trash2, Copy, Check, KeyRound } from "lucide-react";
import { relativeDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/dialog-provider";
import { ErrorText } from "@/components/ui/error-text";
import { EmptyState } from "@/components/ui/empty-state";
import { McpConnect } from "@/components/settings/mcp-connect";

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
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        message: "Revoke this token? Clients using it will start failing.",
        confirmLabel: "Revoke",
        tone: "danger",
      }))
    )
      return;
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
            <Button variant="outline" onClick={copyTokenToClipboard}>
              {copied ? (
                <Check className="size-3.5 text-state-done" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="outline" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Client onboarding — snippets carry the live token when one was
          just created, a placeholder otherwise. */}
      <McpConnect token={created?.token ?? null} />

      {/* New token form */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <h2 className="text-sm font-medium">New token</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            uiSize="sm"
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
            className="flex-1 w-auto min-w-[12rem] rounded-md px-2.5 text-sm"
          />
          <Button onClick={create} disabled={creating || !newName.trim()}>
            {creating ? (
              <Spinner className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Generate
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>

      {/* Existing tokens table */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Existing tokens</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tokens.length === 0 ? (
          <EmptyState>No tokens yet.</EmptyState>
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
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => revoke(t.id)}
                    className="border-state-blocked/30 bg-state-blocked/10 py-0.5 text-[11px] text-state-blocked enabled:hover:border-state-blocked/30 enabled:hover:bg-state-blocked/15 enabled:hover:text-state-blocked"
                  >
                    <Trash2 className="size-3" /> Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
