"use client";

import * as React from "react";
import { Check, ExternalLink, LogOut, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorText } from "@/components/ui/error-text";
import { useConfirm } from "@/components/ui/dialog-provider";

interface CodexAuthStatus {
  signedIn: boolean;
  pending: boolean;
  accountId?: string;
  authPath: string;
  authorizationUrl?: string;
  error?: { code: string; message: string };
}

const POLL_INTERVAL_MS = 2000;

export function CodexLoginPanel() {
  const confirm = useConfirm();
  const [status, setStatus] = React.useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pollRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = React.useCallback(async (): Promise<CodexAuthStatus | null> => {
    const res = await fetch("/api/codex");
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as CodexAuthStatus;
    setStatus(body);
    return body;
  }, []);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Poll while a login is in flight; stop once it lands or errors.
  const poll = React.useCallback(async () => {
    const body = await fetchStatus();
    if (!body) return;
    if (body.signedIn || body.error || !body.pending) {
      stopPolling();
      return;
    }
    pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
  }, [fetchStatus, stopPolling]);

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      const body = await fetchStatus();
      setLoading(false);
      if (body?.pending && !body.signedIn) {
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    })();
    return () => stopPolling();
  }, [fetchStatus, poll, stopPolling]);

  async function signIn() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/codex", { method: "POST" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { authorizationUrl: string; status: CodexAuthStatus };
      setStatus(body.status);
      // Open OpenAI's sign-in page in a new tab; the server's loopback listener
      // catches the redirect back to localhost:1455 and finishes the exchange.
      window.open(body.authorizationUrl, "_blank", "noopener,noreferrer");
      stopPolling();
      pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    } finally {
      setStarting(false);
    }
  }

  async function signOut() {
    if (
      !(await confirm({
        message: "Sign out of ChatGPT? Codex models will stop working until you sign in again.",
        confirmLabel: "Sign out",
        tone: "danger",
      }))
    )
      return;
    setError(null);
    const res = await fetch("/api/codex", { method: "DELETE" });
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    setStatus((await res.json()) as CodexAuthStatus);
  }

  const pending = Boolean(status?.pending && !status?.signedIn);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status?.signedIn ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-state-done/15">
                <Check className="size-3.5 text-state-done" />
              </span>
              <div>
                <div className="font-medium">Signed in with ChatGPT</div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {status.accountId ? `account ${status.accountId}` : status.authPath}
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={signOut}>
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
        ) : pending ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              <Spinner className="size-4" />
              <div>
                <div className="font-medium">Waiting for you to approve in the browser…</div>
                <div className="text-[11px] text-muted-foreground">
                  Complete the sign-in in the tab that opened. This page updates automatically.
                </div>
              </div>
            </div>
            {status?.authorizationUrl && (
              <a
                href={status.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3.5" /> Reopen sign-in
              </a>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              Not signed in. Codex (<code>openai-codex</code>) models need a ChatGPT login.
            </div>
            <Button onClick={signIn} disabled={starting}>
              {starting ? <Spinner className="size-3.5" /> : <MessageSquare className="size-3.5" />}
              Sign in with ChatGPT
            </Button>
          </div>
        )}

        {status?.error && !pending && !status.signedIn && (
          <ErrorText>
            {status.error.message} ({status.error.code})
          </ErrorText>
        )}
        <ErrorText>{error}</ErrorText>
      </div>

      <p className="text-xs text-muted-foreground">
        This runs the OAuth flow on the server: it opens OpenAI&apos;s sign-in page in a new tab and
        catches the redirect on a loopback listener at <code>localhost:1455</code>. Because that
        port is fixed by OpenAI&apos;s public client, sign-in works when your browser and this server
        share a machine (local or self-hosted). Credentials are written to{" "}
        <code>~/.codex/auth.json</code> and refreshed automatically. The{" "}
        <code>npm run task -- codex login</code> CLI command does the same thing.
      </p>
    </div>
  );
}
