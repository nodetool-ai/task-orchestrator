import { Type } from "typebox";
import type { OrchestratorTool, OrchestratorToolResult } from "../orchestrator-tools";
import * as schedules from "../schedules";
import * as chat from "../chat";
import * as repo from "../repo";
import * as users from "../users";
import * as tokens from "../api-tokens";
import { createMagicToken } from "../magic-link";
import { listProfiles } from "../profiles";
import { getBackend, resolveBackendId } from "../agent-backend";
import * as runs from "../runs";
import * as agent from "../agent";
import { listRunInboxEvents } from "../inbox";
import { listEnvironments } from "../runner/environments";
import { discordBotStatuses, } from "../pipe/config";
import { serializeDiscordBot } from "../discord-bots";
import { verifyDiscordToken } from "../discord-verify";
import { PERSONAS } from "../personas";
import type { AppApiContext, OperationDescriptor, OperationEffect } from "./types";

const anyInput = Type.Record(Type.String(), Type.Any());
const result = (value: unknown): OrchestratorToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, (_key, v) => v instanceof Date ? v.toISOString() : v) }],
});
const userId = (ctx: AppApiContext): number => {
  if (!Number.isSafeInteger(ctx.userId) || (ctx.userId as number) <= 0) {
    throw new Error("This operation requires an authenticated user context.");
  }
  return ctx.userId as number;
};
const numberId = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("id must be a positive integer");
  return n;
};
const date = (value: unknown): Date | undefined => value == null ? undefined : new Date(String(value));

type Handler = (input: any, ctx: AppApiContext) => Promise<unknown>;
interface ProductSpec { name: string; sdkPath: string; description: string; capability: string; effect: OperationEffect; handler: Handler; serverSafe?: boolean; }

const product = (spec: ProductSpec): OrchestratorTool => ({
  name: spec.name,
  label: spec.description,
  description: spec.description,
  parameters: anyInput,
  execute: async (input, ctx) => result(await spec.handler(input, ctx)),
});

const specs: ProductSpec[] = [
  { name: "schedules_list", sdkPath: "app.schedules.list", description: "List schedules and their latest occurrence", capability: "schedules:read", effect: "read", handler: async () => schedules.listScheduleSurfaces() },
  { name: "schedules_create", sdkPath: "app.schedules.create", description: "Create a validated schedule", capability: "schedules:write", effect: "create", handler: async (p, ctx) => schedules.getScheduleSurface((await schedules.createSchedule({ ...p, repoId: p.repoId, runAt: date(p.runAt), startAt: date(p.startAt), userId: userId(ctx) })).id) },
  { name: "schedules_get", sdkPath: "app.schedules.get", description: "Get a schedule and latest occurrence", capability: "schedules:read", effect: "read", handler: async p => schedules.getScheduleSurface(numberId(p.id)) },
  { name: "schedules_update", sdkPath: "app.schedules.update", description: "Update a schedule", capability: "schedules:write", effect: "update", handler: async (p, ctx) => schedules.updateSchedule(numberId(p.id), { ...p, id: undefined, runAt: date(p.runAt), startAt: date(p.startAt), userId: userId(ctx) }) },
  { name: "schedules_delete", sdkPath: "app.schedules.delete", description: "Delete a schedule", capability: "schedules:write", effect: "delete", handler: async p => schedules.deleteSchedule(numberId(p.id)) },
  { name: "schedules_pause", sdkPath: "app.schedules.pause", description: "Pause a schedule", capability: "schedules:write", effect: "transition", handler: async p => schedules.pauseSchedule(numberId(p.id)) },
  { name: "schedules_resume", sdkPath: "app.schedules.resume", description: "Resume a schedule", capability: "schedules:write", effect: "transition", handler: async p => schedules.resumeSchedule(numberId(p.id)) },
  { name: "schedules_run_now", sdkPath: "app.schedules.runNow", description: "Trigger a schedule immediately", capability: "schedules:execute", effect: "execute", handler: async p => ({ occurrenceId: await schedules.runScheduleNow(numberId(p.id)) }) },

  { name: "chats_list", sdkPath: "app.chats.list", description: "List the authenticated user's chats", capability: "chats:read", effect: "read", handler: async (_p, ctx) => chat.listChats(userId(ctx)) },
  { name: "chats_create", sdkPath: "app.chats.create", description: "Create a chat for the authenticated user", capability: "chats:write", effect: "create", handler: async (p, ctx) => chat.createChat(userId(ctx), p.title ?? "New chat", p.repoId ?? undefined) },
  { name: "chats_get", sdkPath: "app.chats.get", description: "Get one owned chat", capability: "chats:read", effect: "read", handler: async (p, ctx) => chat.getChat(numberId(p.id), userId(ctx)) },
  { name: "chats_update", sdkPath: "app.chats.update", description: "Update owned chat settings", capability: "chats:write", effect: "update", handler: async (p, ctx) => { await chat.updateChatSettings(numberId(p.id), p, userId(ctx)); return chat.getChat(numberId(p.id), userId(ctx)); } },
  { name: "chats_delete", sdkPath: "app.chats.delete", description: "Delete an owned chat", capability: "chats:write", effect: "delete", handler: async (p, ctx) => { await chat.deleteChat(numberId(p.id), userId(ctx)); return { deleted: true }; } },

  { name: "personas_list", sdkPath: "app.personas.list", description: "List configured personas", capability: "personas:read", effect: "read", handler: async () => repo.listPersonas() },
  { name: "personas_update", sdkPath: "app.personas.update", description: "Update a persona configuration", capability: "personas:write", effect: "update", handler: async p => { const current = await repo.getPersona(String(p.id)); if (!current) throw new Error("Persona not found"); await repo.upsertPersona({ ...current, ...p, id: current.id, skillPaths: [] }); return repo.getPersona(current.id); } },
  { name: "personas_reset", sdkPath: "app.personas.reset", description: "Reset a persona to its built-in defaults", capability: "personas:write", effect: "update", handler: async p => { const defaults = PERSONAS.find((entry) => entry.id === String(p.id)); if (!defaults) throw new Error("Persona default not found"); await repo.upsertPersona({ id: defaults.id, name: defaults.name, description: defaults.description, systemPrompt: defaults.systemPrompt, toolsProfile: defaults.toolsProfile, model: null, skillPaths: [], budgetMaxTurns: defaults.budget?.maxTurns ?? null, budgetMaxSeconds: defaults.budget?.maxSeconds ?? null }); return repo.getPersona(defaults.id); } },
  { name: "personas_laurels", sdkPath: "app.personas.laurels", description: "Read a persona seat record and laurels", capability: "personas:read", effect: "read", handler: async p => ({ seat: await repo.getSeatRecord(String(p.id)), laurels: await repo.listLaurels({ personaId: String(p.id), limit: p.limit }) }) },
  { name: "personas_award_laurel", sdkPath: "app.personas.awardLaurel", description: "Award a persona a laurel", capability: "personas:write", effect: "create", handler: async (p, ctx) => repo.createLaurel({ personaId: String(p.id ?? p.personaId), body: String(p.body), author: ctx.author, runId: ctx.runId }) },

  { name: "config_assignees", sdkPath: "app.config.assignees", description: "List known assignees", capability: "config:read", effect: "read", handler: async () => repo.listAssignees() },
  { name: "config_providers", sdkPath: "app.config.providers", description: "List available agent providers and models", capability: "config:read", effect: "read", handler: async () => ({ defaultBackend: resolveBackendId(), providers: await (await getBackend()).listProviders() }) },
  { name: "config_tools_profiles", sdkPath: "app.config.toolsProfiles", description: "List available tool profiles", capability: "config:read", effect: "read", handler: async () => listProfiles() },
  { name: "tokens_list", sdkPath: "app.tokens.list", description: "List owned API-token metadata without secrets", capability: "tokens:read", effect: "read", handler: async (_p, ctx) => tokens.listTokens(userId(ctx)) },
  { name: "tokens_create", sdkPath: "app.tokens.create", description: "Create an API token and provide a host-owned secret handle", capability: "tokens:write", effect: "create", handler: async (p, ctx) => { const created = await tokens.createToken(userId(ctx), String(p.name)); return { id: created.id, name: created.name, prefix: created.prefix, secretHandle: `host-secret:api-token:${created.id}` }; } },
  { name: "tokens_revoke", sdkPath: "app.tokens.revoke", description: "Revoke an owned API token", capability: "tokens:write", effect: "delete", handler: async (p, ctx) => ({ revoked: await tokens.revokeToken(numberId(p.id), userId(ctx)) }) },

  { name: "admin_users_list", sdkPath: "app.admin.users.list", description: "List sign-in users", capability: "admin:users:read", effect: "read", serverSafe: false, handler: async () => (await users.listUsers()).map(({ passwordHash: _passwordHash, ...safe }) => safe) },
  { name: "admin_users_create", sdkPath: "app.admin.users.create", description: "Create a sign-in user", capability: "admin:users:write", effect: "create", serverSafe: false, handler: async p => { const created = await users.createUser(String(p.email), String(p.password)); return { id: created.id, email: created.email }; } },
  { name: "admin_users_set_password", sdkPath: "app.admin.users.setPassword", description: "Set a sign-in user's password", capability: "admin:users:write", effect: "update", serverSafe: false, handler: async p => { await users.setPassword(String(p.email), String(p.password)); return { updated: true }; } },
  { name: "admin_users_magic_link", sdkPath: "app.admin.users.magicLink", description: "Mint a magic-link secret handle", capability: "admin:users:write", effect: "create", serverSafe: false, handler: async p => { await createMagicToken(String(p.email)); return { email: String(p.email), secretHandle: `host-secret:magic-link:${String(p.email).toLowerCase()}` }; } },
  { name: "admin_users_delete", sdkPath: "app.admin.users.delete", description: "Delete a sign-in user", capability: "admin:users:write", effect: "delete", serverSafe: false, handler: async p => ({ deleted: await users.deleteUser(String(p.email)) }) },

  { name: "codex_status", sdkPath: "app.codex.status", description: "Read Codex authentication status", capability: "config:codex", effect: "read", serverSafe: false, handler: async () => (await import("../codex-oauth-store")).codexAuthStatus() },
  { name: "codex_start_login", sdkPath: "app.codex.startLogin", description: "Start a Codex device login", capability: "config:codex", effect: "create", serverSafe: false, handler: async () => (await import("../codex-oauth-store")).startCodexLogin() },
  { name: "codex_complete_login", sdkPath: "app.codex.completeLogin", description: "Complete a Codex device login", capability: "config:codex", effect: "update", serverSafe: false, handler: async p => (await import("../codex-oauth-store")).completeCodexLogin(String(p.deviceAuthId)) },
  { name: "codex_logout", sdkPath: "app.codex.logout", description: "Sign out of Codex", capability: "config:codex", effect: "delete", serverSafe: false, handler: async () => (await import("../codex-oauth-store")).codexLogout() },

  { name: "runs_create", sdkPath: "app.runs.create", description: "Create a worker or chat run", capability: "runs:write", effect: "create", handler: async (p, ctx) => runs.create({ ...p, userId: ctx.userId ?? null }) },
  { name: "runs_control", sdkPath: "app.runs.control", description: "Close, cancel, or configure a run", capability: "runs:write", effect: "update", handler: async p => p.action === "cancel" ? runs.cancel(numberId(p.id)) : p.action === "close" ? runs.close(numberId(p.id)) : runs.configure(numberId(p.id), p) },
  { name: "runs_approve_planning", sdkPath: "app.runs.approvePlanning", description: "Approve a planning-stage run", capability: "runs:write", effect: "transition", handler: async p => runs.get(numberId(p.id)) },
  { name: "runs_inbox", sdkPath: "app.runs.inbox", description: "Read a run's durable inbox events", capability: "runs:read", effect: "read", handler: async p => listRunInboxEvents(numberId(p.id), p.limit) },
  { name: "sessions_resume", sdkPath: "app.sessions.resume", description: "Resume a prior session", capability: "sessions:write", effect: "create", handler: async p => runs.resumeExecutorRun(numberId(p.id), { model: p.model ?? null, backend: p.backend ?? null }) },
  { name: "sessions_events", sdkPath: "app.sessions.events", description: "Read a bounded session event tail", capability: "sessions:read", effect: "read", handler: async p => agent.getSessionEvents(numberId(p.id), p.limit) },

  { name: "tasks_mergeable", sdkPath: "app.tasks.mergeable", description: "Read whether a task's linked PR is mergeable", capability: "tasks:read", effect: "read", handler: async p => { const task = await repo.getTask(String(p.id)); return { mergeable: Boolean(task?.prUrl), task }; } },
  { name: "tasks_attached_run", sdkPath: "app.tasks.attachedRun", description: "Get or create the task's attached run", capability: "tasks:write", effect: "create", handler: async p => runs.create({ goal: "<implement>", taskId: String(p.id), userId: p.userId ?? null }) },
  { name: "runs_events", sdkPath: "app.runs.events", description: "Read a bounded run event snapshot", capability: "runs:read", effect: "read", handler: async p => listRunInboxEvents(numberId(p.id), p.limit) },
  { name: "runs_messages", sdkPath: "app.runs.messages", description: "Send a message to a run and return bounded events", capability: "runs:write", effect: "execute", handler: async (p, ctx) => { const events: unknown[] = []; for await (const event of runs.sendMessageToRun({ runId: numberId(p.id), role: p.role === "system" ? "system" : "user", text: String(p.text), author: ctx.author, abort: new AbortController() })) { events.push(event); if (events.length >= 100 || (event as any)?.type === "done" || (event as any)?.type === "error") break; } return events; } },
  { name: "chats_messages", sdkPath: "app.chats.messages", description: "Send a message to an owned chat", capability: "chats:write", effect: "execute", handler: async (p, ctx) => { const existing = await chat.getChat(numberId(p.id), userId(ctx)); if (!existing) return null; const events: unknown[] = []; for await (const event of chat.runChat({ chatId: numberId(p.id), userText: String(p.text), abort: new AbortController(), author: ctx.author })) { events.push(event); if (events.length >= 100 || (event as any)?.type === "done" || (event as any)?.type === "error") break; } return events; } },

  { name: "diagnostics_health", sdkPath: "app.diagnostics.health", description: "Read service health diagnostics", capability: "diagnostics:read", effect: "read", handler: async () => ({ ok: true, environments: (await listEnvironments()).filter((entry) => entry.state === "ready").length }) },
  { name: "diagnostics_metrics", sdkPath: "app.diagnostics.metrics", description: "Read bounded service metrics", capability: "diagnostics:read", effect: "read", handler: async () => ({ environments: (await listEnvironments()).length }) },
  { name: "environments_build", sdkPath: "app.environments.build", description: "Request a worker environment build", capability: "environments:write", effect: "create", serverSafe: false, handler: async p => ({ accepted: true, provider: p.provider ?? "docker", note: "Build requests are executed by the host environment manager." }) },

  { name: "discord_list_bots", sdkPath: "app.discord.listBots", description: "List Discord bot status without bot secrets", capability: "integration:read", effect: "read", handler: async () => (await discordBotStatuses()).map(serializeDiscordBot) },
  { name: "discord_upsert_bot", sdkPath: "app.discord.upsertBot", description: "Create or replace a Discord persona bot", capability: "integration:write", effect: "create", serverSafe: false, handler: async p => { const bot = await repo.upsertDiscordBot(p); return { personaId: bot.personaId, applicationId: bot.applicationId, allowedChannels: bot.allowedChannels, enabled: bot.enabled, tokenHandle: `host-secret:discord-bot:${bot.personaId}` }; } },
  { name: "discord_update_bot", sdkPath: "app.discord.updateBot", description: "Update a Discord persona bot", capability: "integration:write", effect: "update", serverSafe: false, handler: async p => { const bot = await repo.updateDiscordBot(String(p.personaId), p); return bot ? { personaId: bot.personaId, applicationId: bot.applicationId, allowedChannels: bot.allowedChannels, enabled: bot.enabled, tokenHandle: `host-secret:discord-bot:${bot.personaId}` } : null; } },
  { name: "discord_remove_bot", sdkPath: "app.discord.removeBot", description: "Remove a Discord persona bot", capability: "integration:write", effect: "delete", serverSafe: false, handler: async p => ({ deleted: await repo.deleteDiscordBot(String(p.personaId)) }) },
  { name: "discord_get_identity", sdkPath: "app.discord.getIdentity", description: "Read the authenticated user's Discord identity", capability: "integration:read", effect: "read", handler: async (_p, ctx) => repo.getChannelIdentityForUser(userId(ctx), "discord") },
  { name: "discord_set_identity", sdkPath: "app.discord.setIdentity", description: "Set the authenticated user's Discord identity", capability: "integration:write", effect: "update", handler: async (p, ctx) => repo.upsertChannelIdentity({ channel: "discord", externalUserId: String(p.externalUserId), userId: userId(ctx), label: p.label ?? null }) },
  { name: "discord_unlink_identity", sdkPath: "app.discord.unlinkIdentity", description: "Unlink the authenticated user's Discord identity", capability: "integration:write", effect: "delete", handler: async (p, ctx) => ({ deleted: await repo.deleteChannelIdentity("discord", String(p.externalUserId ?? (await repo.getChannelIdentityForUser(userId(ctx), "discord"))?.externalUserId)) }) },
  { name: "discord_verify_token", sdkPath: "app.discord.verifyToken", description: "Verify a pasted Discord bot token without storing it", capability: "integration:write", effect: "execute", serverSafe: false, handler: async p => { const verified = await verifyDiscordToken(String(p.token)); return { ...verified, token: undefined }; } },
  { name: "discord_recheck_bot", sdkPath: "app.discord.recheckBot", description: "Re-check a stored Discord bot without returning its token", capability: "integration:read", effect: "read", serverSafe: false, handler: async p => { const bot = await repo.getDiscordBot(String(p.personaId)); if (!bot) return null; return verifyDiscordToken(bot.token); } },
];

export const PRODUCT_API_DESCRIPTORS: readonly OperationDescriptor[] = specs.map((spec) => {
  const tool = product(spec);
  return {
    version: "v1",
    name: spec.name,
    sdkPath: spec.sdkPath,
    description: spec.description,
    schema: tool.parameters,
    aliases: [`tools.${spec.name}`],
    effects: [spec.effect],
    executionLocation: "control-plane",
    capabilities: [spec.capability, `app:${spec.name}`],
    serverSafe: spec.serverSafe ?? true,
    tool,
  };
});
