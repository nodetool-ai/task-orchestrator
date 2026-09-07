"use client";

import * as React from "react";
import { Check, ClipboardCopy, ExternalLink, LogOut, MessageSquare } from "lucide-react";
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

interface DeviceLogin {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
}

export function CodexLoginPanel() {
  const confirm = useConfirm();
  const [status, setStatus] = React.useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [starting, setStarting] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [login, setLogin] = React.useState<DeviceLogin | null>(null);
  const [copied, setCopied] = React.useState(false);

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
      const body = (await res.json()) as DeviceLogin & { status: CodexAuthStatus };
      setStatus(body.status);
      setLogin(body);
      setCopied(false);
      window.open(body.verificationUrl, "_blank", "noopener,noreferrer");
    } finally {
      setStarting(false);
    }
  }

  React.useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      setSubmitting(true);
      const res = await fetch("/api/codex", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceAuthId: login?.deviceAuthId }),
      });
      if (cancelled) return;
      if (!res.ok) {
        setError(await readError(res));
        setSubmitting(false);
        setLogin(null);
        return;
      }
      const next = (await res.json()) as CodexAuthStatus;
      setStatus(next);
      if (next.signedIn) {
        setSubmitting(false);
        setLogin(null);
        return;
      }
      timer = setTimeout(poll, Math.max(login?.intervalSeconds ?? 5, 1) * 1000);
    }

    timer = setTimeout(poll, Math.max(login.intervalSeconds, 1) * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [login]);

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
    setLogin(null);
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
                {login ? "Restart sign-in" : "Sign in with ChatGPT"}
              </Button>
            </div>

            {login && (
              <div className="space-y-3 border-t border-border/60 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">Enter this one-time code</div>
                    <div className="text-xs text-muted-foreground">Expires in 15 minutes</div>
                  </div>
                  <a
                    href={login.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5" /> Open sign-in page
                  </a>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm font-semibold tracking-[0.16em]">
                    {login.userCode}
                  </code>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard.writeText(login.userCode);
                      setCopied(true);
                    }}
                  >
                    <ClipboardCopy className="size-3.5" /> {copied ? "Copied" : "Copy code"}
                  </Button>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                  {submitting && <Spinner className="size-3.5" />}
                  Waiting for authorization. This page will update automatically.
                </div>
              </div>
            )}
          </div>
        )}

        <ErrorText>{error}</ErrorText>
      </div>

      <p className="text-xs text-muted-foreground">
        This uses OpenAI&apos;s device-code flow. Open the sign-in page, enter the one-time code,
        and keep this page open while authorization completes. Unlike a loopback login, this works
        when the server and browser are on different machines. Credentials are stored in the
        orchestrator database and refreshed automatically. The <code>npm run task -- codex login</code>
        CLI command uses the same flow.
      </p>
    </div>
  );
}
