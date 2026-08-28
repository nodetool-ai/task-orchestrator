"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { INVITE_PERMISSIONS_VALUE } from "@/lib/discord-verify";

/**
 * A persona the wizard can offer, with its eligibility already decided. That
 * decision is made on the SERVER (app/settings/page.tsx) because it needs
 * lib/profiles.ts, which must not be bundled into the browser.
 */
export interface DiscordPersonaOption {
  id: string;
  name: string;
  toolsProfile: string;
  /** Why this persona cannot host a bot, or null when it qualifies. */
  blocked: string | null;
}

export interface WizardPersona extends DiscordPersonaOption {
  /** True when a bot already exists for it (finishing REPLACES that bot). */
  hasBot: boolean;
}

interface IdentityState {
  identity: { externalUserId: string; label: string | null } | null;
  linkedCount: number;
}

interface VerifyResult {
  ok: boolean;
  username: string | null;
  applicationId: string | null;
  inviteUrl: string | null;
  error: string | null;
}

const STEPS = [
  "Persona",
  "Create the app",
  "Bot token",
  "Your Discord id",
  "Invite",
  "Finish",
] as const;

/**
 * Guided setup for one persona bot. Six steps, in the order the work actually
 * happens on Discord's side: pick the persona, create the application, paste and
 * VERIFY the token, link your own Discord id, invite the bot, save.
 *
 * Nothing is written until the last step, so abandoning the wizard leaves no
 * half-configured bot behind — and the pasted token only ever goes to
 * /api/discord/verify, which checks it and forgets it.
 */
export function DiscordSetupWizard({
  personas,
  identity,
  envAllowedUsers,
  onLinkIdentity,
  onCancel,
  onDone,
}: {
  personas: WizardPersona[];
  /** The signed-in user's own linked Discord account, and how many exist total. */
  identity: IdentityState;
  /** Legacy DISCORD_ALLOWED_USERS ids, which also count as reachable users. */
  envAllowedUsers: string[];
  /** Link/replace the caller's own id; resolves to the error message, if any. */
  onLinkIdentity: (externalUserId: string) => Promise<string | null>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = React.useState(0);
  const [personaId, setPersonaId] = React.useState("");
  const [token, setToken] = React.useState("");
  const [applicationId, setApplicationId] = React.useState("");
  const [ownIdRaw, setOwnIdRaw] = React.useState(identity.identity?.externalUserId ?? "");
  const [linking, setLinking] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [verified, setVerified] = React.useState<VerifyResult | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reachable = identity.linkedCount + envAllowedUsers.length;
  const persona = personas.find((p) => p.id === personaId) ?? null;
  const inviteUrl =
    applicationId.trim() &&
    `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(
      applicationId.trim()
    )}&scope=${encodeURIComponent(
      "bot applications.commands"
    )}&permissions=${INVITE_PERMISSIONS_VALUE}`;

  // Each step's gate. The allowlist one is the security-relevant gate: a bot with
  // neither its own list nor a workspace default would be refused at pipe boot,
  // so the wizard refuses to finish instead of shipping a bot that cannot run.
  const blocked: string | null =
    step === 0
      ? persona
        ? persona.blocked
        : "Pick a persona to continue."
      : step === 2
        ? verified?.ok
          ? null
          : "Verify the token to continue."
        : step === 3
          ? reachable === 0
            ? "Link your Discord id first — a bot nobody may talk to cannot start."
            : null
          : null;

  async function verify() {
    if (verifying || !token.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/discord/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      const result = (await res.json()) as VerifyResult;
      setVerified(result);
      if (result.applicationId && !applicationId.trim()) setApplicationId(result.applicationId);
    } finally {
      setVerifying(false);
    }
  }

  async function linkOwnId() {
    if (linking || !ownIdRaw.trim()) return;
    setLinking(true);
    setError(null);
    try {
      setError(await onLinkIdentity(ownIdRaw.trim()));
    } finally {
      setLinking(false);
    }
  }

  async function finish() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/discord/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personaId,
          token: token.trim(),
          applicationId: applicationId.trim() || null,
          enabled: true,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers — the link is selectable below anyway.
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {STEPS.map((label, i) => (
            <span
              key={label}
              className={
                i === step
                  ? "rounded bg-foreground px-2 py-0.5 font-medium text-background"
                  : i < step
                    ? "rounded px-2 py-0.5 text-muted-foreground"
                    : "rounded px-2 py-0.5 text-muted-foreground/60"
              }
            >
              {i + 1}. {label}
            </span>
          ))}
        </div>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <X className="size-3.5" /> Cancel
        </Button>
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Each bot speaks as one persona. Only personas with a server-safe tools profile
            qualify — a Discord conversation runs inside the pipe process, so shell, filesystem
            and repo-write tools are not available to it.
          </p>
          <div className="divide-y divide-border/60 rounded-md border border-border/60">
            {personas.map((p) => (
              <button
                key={p.id}
                onClick={() => !p.blocked && setPersonaId(p.id)}
                disabled={Boolean(p.blocked)}
                className={
                  "block w-full px-3 py-2 text-left transition-colors " +
                  (p.blocked
                    ? "cursor-not-allowed opacity-50"
                    : personaId === p.id
                      ? "bg-muted/60"
                      : "hover:bg-muted/40")
                }
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{p.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{p.id}</span>
                  {p.hasBot && (
                    <span className="text-[11px] text-muted-foreground">· already configured</span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {p.toolsProfile}
                </div>
                {p.blocked && (
                  <div className="mt-1 text-[11px] text-state-blocked">{p.blocked}</div>
                )}
              </button>
            ))}
          </div>
          {persona?.hasBot && (
            <p className="text-xs text-state-progress">
              {persona.name} already has a bot. Finishing replaces its token and settings.
            </p>
          )}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Create one Discord application for this persona — its name and avatar are the
            persona&apos;s face on Discord.
          </p>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Open{" "}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                discord.com/developers/applications <ExternalLink className="size-3" />
              </a>{" "}
              and click <strong>New Application</strong>.
            </li>
            <li>
              Go to the <strong>Bot</strong> tab and turn on{" "}
              <strong>Message Content Intent</strong> (Privileged Gateway Intents). Without it the
              bot receives empty message bodies and answers nothing.
            </li>
            <li>
              Still on the <strong>Bot</strong> tab, click <strong>Reset Token</strong> and copy
              the token — Discord shows it exactly once.
            </li>
          </ol>
          <CodeBlock tone="muted">
            {"Bot → Privileged Gateway Intents → Message Content Intent = ON"}
          </CodeBlock>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <label htmlFor="discord-token" className="block text-sm font-medium">
            Paste the bot token
          </label>
          <textarea
            id="discord-token"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setVerified(null);
            }}
            rows={2}
            spellCheck={false}
            placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jk2.…"
            className="w-full rounded-md border border-border/60 bg-background p-2 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={verify} disabled={verifying || !token.trim()}>
              {verifying && <Spinner className="size-3.5" />} Verify with Discord
            </Button>
            {verified?.ok && (
              <span className="inline-flex items-center gap-1.5 text-xs text-state-done">
                <Check className="size-3.5" /> {verified.username ?? "token accepted"}
                {verified.applicationId && (
                  <span className="font-mono text-muted-foreground">
                    · app {verified.applicationId}
                  </span>
                )}
              </span>
            )}
          </div>
          {verified && !verified.ok && <ErrorText>{verified.error}</ErrorText>}
          <p className="text-xs text-muted-foreground">
            The token is checked server-side against{" "}
            <code>discord.com/api/v10/users/@me</code> and is not stored until you finish.
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          <label htmlFor="discord-own-id" className="block text-sm font-medium">
            Your Discord user id
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="discord-own-id"
              mono
              className="max-w-sm"
              value={ownIdRaw}
              onChange={(e) => setOwnIdRaw(e.target.value)}
              placeholder="111111111111111111"
            />
            <Button onClick={linkOwnId} disabled={linking || !ownIdRaw.trim()}>
              {linking && <Spinner className="size-3.5" />}
              {identity.identity ? "Update" : "Link"} my id
            </Button>
            {identity.identity?.externalUserId === ownIdRaw.trim() && (
              <span className="inline-flex items-center gap-1 text-xs text-state-done">
                <Check className="size-3.5" /> linked
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Enable <strong>Developer Mode</strong> in Discord (User Settings → Advanced), then
            right-click your own name → <strong>Copy User ID</strong>. Persona conversations can
            spawn agent runs with full shell access, so the bots only answer people who have
            linked an id.
          </p>
          <p className="text-xs text-muted-foreground">
            Each teammate links their own id the same way, from Settings → Discord — nobody
            curates a list on anyone else&apos;s behalf.
          </p>
          {reachable === 0 ? (
            <ErrorText>
              No one can reach the bots yet. Link your id above (or set{" "}
              <code>DISCORD_ALLOWED_USERS</code>) before finishing.
            </ErrorText>
          ) : (
            <p className="text-xs text-muted-foreground">
              {identity.linkedCount} linked account{identity.linkedCount === 1 ? "" : "s"}
              {envAllowedUsers.length > 0 &&
                ` + ${envAllowedUsers.length} from DISCORD_ALLOWED_USERS`}{" "}
              can talk to this bot.
            </p>
          )}
        </div>
      )}

      {step === 4 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Invite the bot to your server with the <code>bot</code> and{" "}
            <code>applications.commands</code> scopes and the permissions the bridge needs: Send
            Messages, Read Message History, Create Public Threads, Send Messages in Threads, Add
            Reactions.
          </p>
          <div className="space-y-1">
            <label htmlFor="discord-app-id" className="block text-xs font-medium text-muted-foreground">
              Application id (Discord → General Information → Application ID)
            </label>
            <Input
              id="discord-app-id"
              mono
              value={applicationId}
              onChange={(e) => setApplicationId(e.target.value)}
              placeholder="123456789012345678"
            />
          </div>
          {inviteUrl ? (
            <div className="space-y-2">
              <CodeBlock selectable>{inviteUrl}</CodeBlock>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={copyInvite}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy invite URL"}
                </Button>
                <a
                  href={inviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="size-3.5" /> Open invite
                </a>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Add the application id to generate the invite URL. You can also skip this and invite
              the bot later — without an application id only slash-command registration is skipped.
            </p>
          )}
        </div>
      )}

      {step === 5 && (
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <div className="flex gap-2">
              <span className="w-28 text-muted-foreground">Persona</span>
              <span className="font-mono text-xs">{personaId}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-28 text-muted-foreground">Bot</span>
              <span className="font-mono text-xs">
                {verified?.username ?? "verified"} · token ends …{token.trim().slice(-4)}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="w-28 text-muted-foreground">Application</span>
              <span className="font-mono text-xs">{applicationId.trim() || "not set"}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-28 text-muted-foreground">Allowed users</span>
              <span className="font-mono text-xs">
                {identity.linkedCount} linked
                {envAllowedUsers.length > 0 && ` + ${envAllowedUsers.length} from env`}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Saving stores the bot in the database. The pipe reads its config once at boot, so
            restart it (<code>npm run pipe</code>) to bring this bot online.
          </p>
        </div>
      )}

      <ErrorText>{error}</ErrorText>

      <div className="flex items-center justify-between border-t border-border/60 pt-3">
        <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
          <ArrowLeft className="size-3.5" /> Back
        </Button>
        <div className="flex items-center gap-3">
          {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={Boolean(blocked)}>
              Next <ArrowRight className="size-3.5" />
            </Button>
          ) : (
            <Button onClick={finish} disabled={saving}>
              {saving && <Spinner className="size-3.5" />} Save bot
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
