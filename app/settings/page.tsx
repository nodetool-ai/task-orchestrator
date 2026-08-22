import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import * as repo from "@/lib/repo";
import { NewRepositoryForm } from "@/components/repositories/repository-form";
import { PersonaEditor, type PersonaDto } from "@/components/persona-editor";
import { ApiTokensManager } from "@/components/api-tokens-manager";
import { CodexLoginPanel } from "@/components/settings/codex-login";
import { DiscordSettings } from "@/components/settings/discord-settings";
import type { DiscordPersonaOption } from "@/components/settings/discord-setup-wizard";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, relativeDate } from "@/lib/utils";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { listEnvironments, registerConfiguredEnvironments } from "@/lib/runner/environments";
import { EnvironmentsView } from "@/components/environments/environments-view";
import { serverUnsafeProfiles } from "@/lib/profiles";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  await registerConfiguredEnvironments();
  const [repositories, personaRows, environmentRows] = await Promise.all([
    repo.listRepositories(),
    repo.listPersonas(),
    listEnvironments(),
  ]);

  const personas: PersonaDto[] = personaRows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    modelProvider: p.modelProvider,
    modelId: p.modelId,
    thinkingLevel: p.thinkingLevel,
    toolsProfile: p.toolsProfile,
    backend: p.backend,
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  }));

  // Which personas can host a Discord bot. Decided here because it needs
  // lib/profiles.ts, which is server code — the browser only sees the verdict.
  const discordPersonas: DiscordPersonaOption[] = personaRows.map((p) => {
    const unsafe = serverUnsafeProfiles(p.toolsProfile);
    const backend = p.backend ?? "pi";
    return {
      id: p.id,
      name: p.name,
      toolsProfile: p.toolsProfile,
      backend: p.backend,
      blocked:
        unsafe.length > 0
          ? `Tools profile is not server-safe (${unsafe.join(", ")}).`
          : backend !== "pi"
            ? `Backend is '${backend}'; Discord conversations need 'pi'.`
            : null,
    };
  });

  return (
    <div style={{ padding: "20px 20px 80px", maxWidth: 1480, margin: "0 auto" }}>
      <header className="mb-6 space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Repositories, personas, environments, and API tokens for this workspace.
        </p>
      </header>

      <SettingsTabs
        initialTab={tab}
        repos={
          <div className="space-y-6">
            <header className="flex items-baseline justify-between">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Repositories</h2>
                <p className="text-sm text-muted-foreground">
                  Git checkouts the orchestrator drives. Each plan and chat picks one.
                </p>
              </div>
              <NewRepositoryForm />
            </header>

            {repositories.length === 0 ? (
              <EmptyState>No repositories configured.</EmptyState>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/40">
                {repositories.map((r) => (
                  <Link
                    key={r.id}
                    href={`/repositories/${r.id}`}
                    className="block px-4 py-3 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <FolderGit2 className="size-3.5 text-muted-foreground" />
                      <span className="text-sm font-medium">{r.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{r.id}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        default: {r.defaultBranch}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground font-mono">
                      {r.localPath ? (
                        <span>local: {r.localPath}</span>
                      ) : (
                        <span className="text-state-blocked">local path not set</span>
                      )}
                      {r.remote && <span>remote: {r.remote}</span>}
                      <span>created {formatDate(r.createdAt)}</span>
                      <span>· {relativeDate(r.updatedAt)}</span>
                    </div>
                    {r.description && (
                      <div className="mt-1 text-xs text-muted-foreground">{r.description}</div>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>
        }
        personas={
          <div className="space-y-6">
            <header className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">Personas</h2>
              <p className="text-sm text-muted-foreground">
                Each persona bundles a system prompt, tools profile, and budget
                defaults. The model is a persona default and can still be
                overridden per-run when you launch the agent.
                Skills are loaded automatically from the project
                (<code>.pi/skills/</code>, <code>.agents/skills/</code>) — no
                per-persona setup needed. Edits saved here override the seed in{" "}
                <code>lib/personas/*.ts</code>.
              </p>
            </header>

            {personas.length === 0 ? (
              <EmptyState>No personas configured.</EmptyState>
            ) : (
              <ul className="space-y-4">
                {personas.map((p) => (
                  <PersonaEditor key={p.id} persona={p} />
                ))}
              </ul>
            )}
          </div>
        }
        environments={
          <div className="space-y-6">
            <header className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">Environments</h2>
              <p className="text-sm text-muted-foreground">
                The execution artifact each runner provider launches from — a
                Docker image, a Fly runner image, or a Box template snapshot —
                versioned by worker build SHA.
              </p>
            </header>
            <EnvironmentsView
              rows={environmentRows.map((r) => ({
                id: r.id,
                provider: r.provider,
                workerSha: r.workerSha,
                state: r.state,
                artifact: r.boxId ?? r.image ?? null,
                detail: r.detail,
                error: r.error,
                createdAt: r.createdAt.toISOString(),
                readyAt: r.readyAt?.toISOString() ?? null,
              }))}
            />
          </div>
        }
        tokens={
          <div className="space-y-6">
            <header className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">API tokens</h2>
              <p className="text-sm text-muted-foreground">
                Tokens authenticate the MCP server at <code>POST /api/mcp</code>. Pass{" "}
                <code>Authorization: Bearer tot_…</code>. Each token inherits its owner&apos;s
                permissions and can be revoked at any time. Generate one below, then copy the
                config for your client — deployment and operations notes live in{" "}
                <code>docs/mcp-server.md</code>.
              </p>
            </header>
            <ApiTokensManager />
          </div>
        }
        codex={
          <div className="space-y-6">
            <header className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">Codex (ChatGPT) sign-in</h2>
              <p className="text-sm text-muted-foreground">
                Sign in with ChatGPT so the <code>pi</code> backend can run{" "}
                <code>openai-codex</code> models. This is the same OAuth login as the{" "}
                <code>codex login</code> CLI command, driven from the browser.
              </p>
            </header>
            <CodexLoginPanel />
          </div>
        }
        discord={
          <div className="space-y-6">
            <header className="space-y-1">
              <h2 className="text-base font-semibold tracking-tight">Discord persona bots</h2>
              <p className="text-sm text-muted-foreground">
                One Discord application (and bot token) per persona, bridged by{" "}
                <code>npm run pipe</code>. Configure them here instead of{" "}
                <code>DISCORD_BOT_TOKEN_&lt;PERSONA_ID&gt;</code> — the env vars still work and
                are merged in as a fallback.
              </p>
            </header>
            <DiscordSettings personas={discordPersonas} />
          </div>
        }
      />
    </div>
  );
}
