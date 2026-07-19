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
  expiresAt?: string;
  updatedAt?: string;
}

export function CodexLoginPanel() {
  const confirm = useConfirm();
  const [status, setStatus] = React.useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [starting, setStarting] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Set once a login is started; holds the URL so the user can reopen the tab.
  const [authorizationUrl, setAuthorizationUrl] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");

  const fetchStatus = React.useCallback(async () => {
    const res = await fetch("/api/codex");
    if (!res.ok) {
      setError(`HTTP ${res.status}`);
      return;
    }
    setStatus((await res.json()) as CodexAuthStatus);
  }, []);

  React.useEffect(() => {
    void (async () => {
      await fetchStatus();
      setLoading(false);
    })();
  }, [fetchStatus]);

  async function readError(res: Response): Promise<string> {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    return b.error ?? `HTTP ${res.status}`;
  }

  async function signIn() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/codex", { method: "POST" });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json()) as { authorizationUrl: string; status: CodexAuthStatus };
      setStatus(body.status);
      setAuthorizationUrl(body.authorizationUrl);
      setCode("");
      window.open(body.authorizationUrl, "_blank", "noopener,noreferrer");
    } finally {
      setStarting(false);
    }
  }

  async function submitCode() {
    if (submitting || !code.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/codex", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setStatus((await res.json()) as CodexAuthStatus);
      setAuthorizationUrl(null);
      setCode("");
    } finally {
      setSubmitting(false);
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
      setError(await readError(res));
      return;
    }
    setStatus((await res.json()) as CodexAuthStatus);
    setAuthorizationUrl(null);
  }

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
                  {status.accountId ? `account ${status.accountId}` : "stored in database"}
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={signOut}>
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                Not signed in. Codex (<code>openai-codex</code>) models need a ChatGPT login.
              </div>
              <Button onClick={signIn} disabled={starting}>
                {starting ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <MessageSquare className="size-3.5" />
                )}
                {authorizationUrl ? "Restart sign-in" : "Sign in with ChatGPT"}
              </Button>
            </div>

            {authorizationUrl && (
              <div className="space-y-2 border-t border-border/60 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="codex-code" className="text-sm font-medium">
                    Paste the code from the ChatGPT page
                  </label>
                  <a
                    href={authorizationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" /> Reopen sign-in
                  </a>
                </div>
                <textarea
                  id="codex-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder="ac_… — or paste the whole https://auth.openai.com/deviceauth/callback?… URL"
                  className="w-full rounded-md border border-border/60 bg-background p-2 font-mono text-xs"
                />
                <Button onClick={submitCode} disabled={submitting || !code.trim()}>
                  {submitting && <Spinner className="size-3.5" />} Complete sign-in
                </Button>
              </div>
            )}
          </div>
        )}

        <ErrorText>{error}</ErrorText>
      </div>

      <p className="text-xs text-muted-foreground">
        This uses OpenAI&apos;s device-code flow: sign-in opens in a new tab, and OpenAI redirects
        to a page showing an authorization code. Copy that code (or the whole callback URL) back
        here. Unlike a loopback login, this works when the server and your browser are on different
        machines — a hosted deployment included. Credentials are stored in the orchestrator database
        and refreshed automatically. The <code>npm run task -- codex login</code> CLI command does
        the same thing.
      </p>
    </div>
  );
}
