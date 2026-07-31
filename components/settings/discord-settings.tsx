"use client";

import * as React from "react";
import { AlertTriangle, Check, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ui/dialog-provider";
import {
  DiscordSetupWizard,
  type DiscordPersonaOption,
  type WizardPersona,
} from "@/components/settings/discord-setup-wizard";

interface BotDto {
  personaId: string;
  personaName: string | null;
  enabled: boolean;
  configured: boolean;
  tokenLast4: string;
  applicationId: string | null;
  inviteUrl: string | null;
  allowedUsers: string[];
  linkedUserCount: number;
  allowedChannels: string[];
  problems: string[];
  valid: boolean;
  updatedAt: string;
}

interface IdentityDto {
  identity: { externalUserId: string; label: string | null; createdAt: string } | null;
  linkedCount: number;
  envAllowedUsers: string[];
}

/**
 * Settings → Discord. Persona bots used to be env-only
 * (DISCORD_BOT_TOKEN_<PERSONA_ID>); they are configured here instead, and the
 * env vars keep working as a fallback.
 *
 * The pipe reads its config ONCE at boot and there is no live-reload channel
 * between the web server and that process, so every mutation here ends with the
 * same honest note: restart `npm run pipe`.
 */
export function DiscordSettings({ personas }: { personas: DiscordPersonaOption[] }) {
  const confirm = useConfirm();
  const [bots, setBots] = React.useState<BotDto[]>([]);
  const [identity, setIdentity] = React.useState<IdentityDto>({
    identity: null,
    linkedCount: 0,
    envAllowedUsers: [],
  });
  const [loading, setLoading] = React.useState(true);
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [ownIdRaw, setOwnIdRaw] = React.useState("");
  const [linking, setLinking] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState<string | null>(null);
  const [checkResult, setCheckResult] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    setError(null);
    const [botsRes, identityRes] = await Promise.all([
      fetch("/api/discord/bots"),
      fetch("/api/discord/identity"),
    ]);
    if (!botsRes.ok || !identityRes.ok) {
      setError(`HTTP ${[botsRes, identityRes].find((r) => !r.ok)!.status}`);
      return;
    }
    const botsBody = (await botsRes.json()) as { bots: BotDto[] };
    const identityBody = (await identityRes.json()) as IdentityDto;
    setBots(botsBody.bots);
    setIdentity(identityBody);
    setOwnIdRaw(identityBody.identity?.externalUserId ?? "");
  }, []);

  React.useEffect(() => {
    void (async () => {
      await load();
      setLoading(false);
    })();
  }, [load]);

  async function readError(res: Response): Promise<string> {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    return b.error ?? `HTTP ${res.status}`;
  }

  /** Link (or move) the caller's OWN Discord id. Returns an error message, or null. */
  const linkIdentity = React.useCallback(
    async (externalUserId: string): Promise<string | null> => {
      const res = await fetch("/api/discord/identity", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalUserId }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        return b.error ?? `HTTP ${res.status}`;
      }
      const body = (await res.json()) as IdentityDto;
      setIdentity(body);
      setOwnIdRaw(body.identity?.externalUserId ?? "");
      await load();
      setDirty(true);
      return null;
    },
    [load]
  );

  async function saveOwnId() {
    if (linking || !ownIdRaw.trim()) return;
    setLinking(true);
    setError(null);
    try {
      setError(await linkIdentity(ownIdRaw.trim()));
    } finally {
      setLinking(false);
    }
  }

  async function unlinkOwnId() {
    if (
      !(await confirm({
        message: "Unlink your Discord account? The persona bots will stop answering you.",
        confirmLabel: "Unlink",
        tone: "danger",
      }))
    )
      return;
    setError(null);
    const res = await fetch("/api/discord/identity", { method: "DELETE" });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    setIdentity((await res.json()) as IdentityDto);
    setOwnIdRaw("");
    await load();
    setDirty(true);
  }

  async function toggleEnabled(bot: BotDto) {
    setError(null);
    const res = await fetch(`/api/discord/bots/${encodeURIComponent(bot.personaId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !bot.enabled }),
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    await load();
    setDirty(true);
  }

  async function remove(bot: BotDto) {
    if (
      !(await confirm({
        message: `Delete the ${bot.personaName ?? bot.personaId} bot? Its token is removed from the database.`,
        confirmLabel: "Delete",
        tone: "danger",
      }))
    )
      return;
    setError(null);
    const res = await fetch(`/api/discord/bots/${encodeURIComponent(bot.personaId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setError(await readError(res));
      return;
    }
    await load();
    setDirty(true);
  }

  // Re-check a stored token by NAMING the bot: the browser never holds it.
  async function checkToken(bot: BotDto) {
    setChecking(bot.personaId);
    setError(null);
    try {
      const res = await fetch(
        `/api/discord/verify?personaId=${encodeURIComponent(bot.personaId)}`
      );
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json()) as { ok: boolean; username: string | null; error: string | null };
      setCheckResult((prev) => ({
        ...prev,
        [bot.personaId]: body.ok
          ? `Token valid — ${body.username ?? "connected"}`
          : (body.error ?? "Token rejected"),
      }));
    } finally {
      setChecking(null);
    }
  }

  // Eligibility (server-safe profile + pi backend) is decided on the server and
  // passed in: lib/profiles.ts is server code and must not reach the browser.
  const wizardPersonas: WizardPersona[] = personas.map((p) => ({
    ...p,
    hasBot: bots.some((b) => b.personaId === p.id),
  }));

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      {dirty && (
        <div className="rounded-md border border-state-progress/40 bg-state-progress/10 p-3 text-xs">
          Configuration changed. Restart the pipe process (<code>npm run pipe</code>) to apply it —
          the bridge reads this config once at boot.
        </div>
      )}

      {/* Your own Discord account — self-service, one card per signed-in user */}
      <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Your Discord account</h3>
          <p className="text-xs text-muted-foreground">
            The persona bots answer people who have linked their own Discord id — there is no
            admin-curated allowlist. Enable <strong>Developer Mode</strong> in Discord (User
            Settings → Advanced), then right-click your name → <strong>Copy User ID</strong>.
            Every teammate links their own id here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            mono
            className="max-w-sm"
            value={ownIdRaw}
            onChange={(e) => setOwnIdRaw(e.target.value)}
            placeholder="111111111111111111"
          />
          <Button onClick={saveOwnId} disabled={linking || !ownIdRaw.trim()}>
            {linking ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
            {identity.identity ? "Update" : "Link"}
          </Button>
          {identity.identity && (
            <Button variant="ghost" size="xs" onClick={unlinkOwnId}>
              <Trash2 className="size-3" /> Unlink
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {identity.identity ? (
            <>
              Linked as <span className="font-mono">{identity.identity.externalUserId}</span>. Your
              Discord messages are also attributed to this account in the orchestrator.
            </>
          ) : (
            "Not linked — the bots will ignore you until you add your id."
          )}{" "}
          {identity.linkedCount} account{identity.linkedCount === 1 ? "" : "s"} linked in total
          {identity.envAllowedUsers.length > 0 &&
            `, plus ${identity.envAllowedUsers.length} from DISCORD_ALLOWED_USERS`}
          .
        </p>
      </div>

      {/* Bots */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">Persona bots</h3>
          {!wizardOpen && (
            <Button onClick={() => setWizardOpen(true)}>
              <Plus className="size-3.5" /> Add bot
            </Button>
          )}
        </div>

        {wizardOpen && (
          <DiscordSetupWizard
            personas={wizardPersonas}
            identity={identity}
            envAllowedUsers={identity.envAllowedUsers}
            onLinkIdentity={linkIdentity}
            onCancel={() => setWizardOpen(false)}
            onDone={async () => {
              setWizardOpen(false);
              await load();
              setDirty(true);
            }}
          />
        )}

        {bots.length === 0 ? (
          <EmptyState>
            No Discord bots configured here. Bots defined through{" "}
            <code>DISCORD_BOT_TOKEN_&lt;PERSONA_ID&gt;</code> still work and are not listed.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            {bots.map((bot) => (
              <BotCard
                key={bot.personaId}
                bot={bot}
                checking={checking === bot.personaId}
                checkResult={checkResult[bot.personaId]}
                onToggle={() => toggleEnabled(bot)}
                onCheck={() => checkToken(bot)}
                onDelete={() => remove(bot)}
              />
            ))}
          </div>
        )}
      </div>

      <ErrorText>{error}</ErrorText>

      <p className="text-xs text-muted-foreground">
        Bots configured here are stored in the database and merged with the <code>DISCORD_*</code>{" "}
        environment at pipe boot — a row here wins for its persona. Start the bridge with{" "}
        <code>npm run pipe</code>; it reads the configuration once, so restart it after changes.
      </p>
    </div>
  );
}

function BotCard({
  bot,
  checking,
  checkResult,
  onToggle,
  onCheck,
  onDelete,
}: {
  bot: BotDto;
  checking: boolean;
  checkResult?: string;
  onToggle: () => void;
  onCheck: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{bot.personaName ?? bot.personaId}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{bot.personaId}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            token …{bot.tokenLast4}
          </span>
          {bot.enabled ? (
            bot.valid ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-state-done">
                <Check className="size-3" /> ready
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-state-blocked">
                <AlertTriangle className="size-3" /> misconfigured
              </span>
            )
          ) : (
            <span className="text-[11px] text-muted-foreground">disabled</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="xs" onClick={onCheck} disabled={checking}>
            {checking ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />} Check
            token
          </Button>
          <Button variant="outline" size="xs" onClick={onToggle}>
            {bot.enabled ? "Disable" : "Enable"}
          </Button>
          <Button variant="ghost" size="xs" onClick={onDelete}>
            <Trash2 className="size-3" /> Delete
          </Button>
        </div>
      </div>

      {bot.problems.map((p) => (
        <p key={p} className="text-xs text-state-blocked">
          {p}
        </p>
      ))}
      {checkResult && <p className="text-xs text-muted-foreground">{checkResult}</p>}

      <div className="grid gap-1 text-[11px] text-muted-foreground md:grid-cols-2">
        <div>
          application id:{" "}
          <span className="font-mono">{bot.applicationId ?? "not set"}</span>
        </div>
        <div>
          channels:{" "}
          <span className="font-mono">
            {bot.allowedChannels.length ? bot.allowedChannels.join(", ") : "any"}
          </span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        allowed users:{" "}
        <span className="font-mono">{bot.allowedUsers.join(", ") || "nobody yet"}</span> —{" "}
        {bot.linkedUserCount} linked in Settings
        {bot.allowedUsers.length > bot.linkedUserCount &&
          `, ${bot.allowedUsers.length - bot.linkedUserCount} from DISCORD_ALLOWED_USERS`}
      </p>

      {bot.inviteUrl && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">Invite URL</summary>
          <CodeBlock selectable className="mt-2">
            {bot.inviteUrl}
          </CodeBlock>
        </details>
      )}
    </div>
  );
}
