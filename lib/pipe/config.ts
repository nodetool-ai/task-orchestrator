// lib/pipe/config.ts
//
// Load the channel-bridge config. Bots come from TWO places, in this order:
//
//   1. The `discord_bots` table, written by Settings → Discord (the guided setup
//      wizard). This is the preferred path — no redeploy to add a bot.
//   2. The DISCORD_* environment, unchanged and fully supported, merged in as a
//      fallback. A DB row WINS for its persona; env-only personas still boot.
//
// Env discovery follows the project's TASK_ORCH_* / dotenv convention (see
// cli.ts and .env.example).
//
// Since M4 the bridge is MULTI-BOT (design §1): one Discord application + token
// per persona, discovered from `DISCORD_BOT_TOKEN_<PERSONA_ID>` env vars, all
// running inside the single pipe process.
//
//   DISCORD_BOT_TOKEN_CONCIERGE=...      # persona 'concierge'
//   DISCORD_BOT_TOKEN_PLANNING_AGENT=... # persona 'planning-agent' (- → _)
//   DISCORD_APP_ID_CONCIERGE=...         # optional: slash-command registration
//   DISCORD_ALLOWED_USERS=...            # global default (mandatory)
//   DISCORD_ALLOWED_USERS_CONCIERGE=...  # optional per-bot override
//   DISCORD_ALLOWED_CHANNELS=...         # global default (optional)
//   DISCORD_ALLOWED_CHANNELS_QA=...      # optional per-bot override
//   DISCORD_BOT_TOKEN=...                # legacy single-bot form, mapped to
//   DISCORD_DEFAULT_PERSONA=implementor  # ...this persona
//
// SECURITY, and why this function refuses to start rather than warning:
//
//  1. Allowlist (unchanged posture). Every bot needs a non-empty effective user
//     allowlist. Persona turns can spawn containerized worker runs, which DO get
//     bypassPermissions shells — an open bot is an open shell one hop away.
//  2. Server-safe tools (design §3/§6, new in M4). A persona conversation is a
//     `runtime: 'server'` run: its turns execute IN this process, with
//     DATABASE_URL and the orchestrator's own checkout in reach, so the tool
//     surface IS the sandbox. runs.create enforces this per run — but a persona
//     with a shell/fs/repo-write profile would then fail on EVERY message
//     instead of at boot, which is a miserable way to learn about a config
//     mistake. Check it once, here, and name the offending profile keys.
//  3. Pi backend (design §3). Server runtime implies the postgres-turn loop,
//     which the Claude backend cannot drive. Same reasoning: boot error, not a
//     per-message crash.

import { config } from "@/lib/config";
import { listServerSafeProfiles, serverUnsafeProfiles } from "@/lib/profiles";
import * as repo from "@/lib/repo";

import type { PersonaBotConfig, PipeConfig } from "./types";

/** Persona the legacy single-bot `DISCORD_BOT_TOKEN` maps to when
 *  `DISCORD_DEFAULT_PERSONA` is unset. */
export const DEFAULT_PERSONA_ID = "implementor";

const TOKEN_PREFIX = "DISCORD_BOT_TOKEN_";

type Env = Record<string, string | undefined>;

/**
 * The env-var suffix for a persona id: upper-snake, so `planning-agent` →
 * `PLANNING_AGENT`. Not invertible on its own (`-` and `_` both become `_`),
 * which is exactly why discovery resolves suffixes by mapping over the persona
 * ids that actually exist rather than by parsing the suffix.
 */
export function personaEnvSuffix(personaId: string): string {
  return personaId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

/**
 * Build the bridge config: discover the persona bots in `env`, then validate
 * every one of them against the personas table.
 *
 * Async because validation is DB-backed (see the security note above). Callers
 * must have initialised the db singleton first — scripts/pipe.ts imports `../db`
 * before this module for exactly that reason.
 */
export async function loadPipeConfig(env: Env = process.env): Promise<PipeConfig> {
  const personaIds = await repo.listPersonaIds();
  const bySuffix = new Map<string, string>();
  for (const id of personaIds) bySuffix.set(personaEnvSuffix(id), id);

  // Who may talk to the bots is DERIVED, not configured: every Discord account
  // someone linked in Settings (channel_identities), unioned with the legacy
  // DISCORD_ALLOWED_USERS env vars. It applies to env-discovered bots too, so a
  // deployment that adopts self-service linking does not have to keep editing
  // its env to add people.
  const linked = await repo.listChannelIdentityExternalIds("discord");
  const envBots = discoverBots(env, bySuffix).map((bot) => ({
    ...bot,
    allowedUsers: [...new Set([...linked, ...bot.allowedUsers])],
  }));
  const dbBots = await discoverDbBots(env, linked);
  const bots = mergeBots(dbBots, envBots);
  if (bots.length === 0) {
    throw new Error(
      "No Discord bot tokens found — refusing to start. Configure a bot in Settings → Discord, " +
        "or set DISCORD_BOT_TOKEN_<PERSONA_ID> " +
        `(e.g. DISCORD_BOT_TOKEN_${personaEnvSuffix(DEFAULT_PERSONA_ID)}) for each persona bot, ` +
        "or the legacy DISCORD_BOT_TOKEN for a single-bot deployment."
    );
  }

  // Env-sourced bots keep the historical posture: any problem is a boot
  // refusal (see the security note above). DB-sourced bots are edited in the
  // UI, where a bad save must not lock the operator out of a running pipe — the
  // offending bot is skipped with a loud warning instead, and Settings surfaces
  // the same problem through /api/discord/bots.
  const usable: PersonaBotConfig[] = [];
  for (const bot of bots) {
    if (bot.source !== "db") {
      await validateBot(bot);
      usable.push(bot);
      continue;
    }
    const problems = await botProblems(bot);
    if (problems.length === 0) {
      usable.push(bot);
      continue;
    }
    console.warn(
      `[pipe] skipping the '${bot.personaId}' bot configured in Settings → Discord: ` +
        `${problems.join(" ")} Fix it in Settings and restart the pipe.`
    );
  }
  if (usable.length === 0) {
    throw new Error(
      "Every configured Discord bot failed validation — refusing to start. See the warnings " +
        "above, or open Settings → Discord, which flags the same problems per bot."
    );
  }

  // The DISCORD_* vars come from `env` (injectable, so discovery is testable
  // without mutating the process environment); the TASK_ORCH_* tunables come
  // from lib/config, which is the one place allowed to read them (R6 guard).
  return {
    bots: usable,
    defaultModel: config.agent.chatModel ?? "openai/gpt-5.6-sol",
    editThrottleMs: config.pipe.editThrottleMs,
  };
}

/**
 * DB discovery: the enabled discord_bots rows written by Settings → Discord.
 *
 * The user allowlist is the linked-identity set unioned with the legacy
 * DISCORD_ALLOWED_USERS env vars (global plus this bot's suffix) — self-service
 * by design: nobody curates a list of other people's snowflakes, you link your
 * own id and the bots answer you. Channels come from the row, falling back to
 * the DISCORD_ALLOWED_CHANNELS env global.
 */
async function discoverDbBots(env: Env, linked: string[]): Promise<PersonaBotConfig[]> {
  const rows = (await repo.listDiscordBots()).filter((row) => row.enabled);
  if (rows.length === 0) return [];
  const channels = csv(env.DISCORD_ALLOWED_CHANNELS);
  return rows.map((row) => ({
    personaId: row.personaId,
    token: row.token,
    source: "db" as const,
    allowedUsers: [
      ...new Set([
        ...linked,
        ...csv(env.DISCORD_ALLOWED_USERS),
        ...csv(env[`DISCORD_ALLOWED_USERS_${personaEnvSuffix(row.personaId)}`]),
      ]),
    ],
    // A per-bot channel list REPLACES the global one, matching the env rule.
    allowedChannels: row.allowedChannels.length ? row.allowedChannels : channels,
    applicationId: row.applicationId ?? undefined,
  }));
}

/** DB rows win per persona; env-only personas are merged in as a fallback. */
function mergeBots(dbBots: PersonaBotConfig[], envBots: PersonaBotConfig[]): PersonaBotConfig[] {
  const byPersona = new Map<string, PersonaBotConfig>();
  for (const bot of envBots) byPersona.set(bot.personaId, { ...bot, source: "env" });
  for (const bot of dbBots) byPersona.set(bot.personaId, bot);
  return [...byPersona.values()].sort((a, b) => a.personaId.localeCompare(b.personaId));
}

/** Env discovery only (no DB): DISCORD_BOT_TOKEN_* plus the legacy mapping. */
function discoverBots(env: Env, bySuffix: Map<string, string>): PersonaBotConfig[] {
  const globalUsers = csv(env.DISCORD_ALLOWED_USERS);
  const globalChannels = csv(env.DISCORD_ALLOWED_CHANNELS);
  const known = () => [...bySuffix.values()].join(", ") || "(none)";
  const bots = new Map<string, PersonaBotConfig>();

  const add = (personaId: string, suffix: string, token: string, fromLegacyToken = false) => {
    bots.set(personaId, {
      personaId,
      token,
      fromLegacyToken,
      // A per-bot override REPLACES the global list (it does not extend it): the
      // point of DISCORD_ALLOWED_USERS_QA is "only these people get the QA bot".
      allowedUsers: csvOr(env[`DISCORD_ALLOWED_USERS_${suffix}`], globalUsers),
      allowedChannels: csvOr(env[`DISCORD_ALLOWED_CHANNELS_${suffix}`], globalChannels),
      applicationId: str(env[`DISCORD_APP_ID_${suffix}`]),
    });
  };

  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith(TOKEN_PREFIX)) continue;
    const token = str(env[key]);
    if (!token) continue;
    const suffix = key.slice(TOKEN_PREFIX.length);
    const personaId = bySuffix.get(suffix);
    if (!personaId) {
      throw new Error(
        `${key} names an unknown persona — refusing to start. No persona in the database maps ` +
          `to the suffix '${suffix}'. Known personas: ${known()}.`
      );
    }
    add(personaId, suffix, token);
  }

  const legacyToken = str(env.DISCORD_BOT_TOKEN);
  if (legacyToken) {
    const requested = str(env.DISCORD_DEFAULT_PERSONA) ?? DEFAULT_PERSONA_ID;
    const suffix = personaEnvSuffix(requested);
    const personaId = bySuffix.get(suffix);
    if (!personaId) {
      throw new Error(
        `DISCORD_DEFAULT_PERSONA='${requested}' is not a known persona — refusing to start. ` +
          `The legacy DISCORD_BOT_TOKEN is bound to this persona. Known personas: ${known()}.`
      );
    }
    if (bots.has(personaId)) {
      // Explicit per-persona token wins; say so rather than silently picking one.
      console.warn(
        `[pipe] ignoring legacy DISCORD_BOT_TOKEN: persona '${personaId}' already has an ` +
          `explicit ${TOKEN_PREFIX}${suffix}.`
      );
    } else {
      add(personaId, suffix, legacyToken, true);
    }
  }

  return [...bots.values()].sort((a, b) => a.personaId.localeCompare(b.personaId));
}

/**
 * The fix line appended to a refusal for a bot that came from the LEGACY
 * `DISCORD_BOT_TOKEN` (design §1, Migration/rollout). Such a deployment has no
 * `DISCORD_BOT_TOKEN_<PERSONA>` to edit — its one lever is which persona the
 * legacy token binds to, so name that lever explicitly. This is the expected
 * upgrade experience for a pre-M4 deployment whose default persona
 * (`implementor`) is a repo-writing contributor profile: it refuses to boot on
 * purpose (§6 posture), and the fix is one env var.
 */
function legacyFix(personaId: string): string {
  return (
    ` FIX: this bot comes from the legacy DISCORD_BOT_TOKEN, which is bound to persona ` +
    `'${personaId}' (DISCORD_DEFAULT_PERSONA, defaulting to '${DEFAULT_PERSONA_ID}'). Set ` +
    `DISCORD_DEFAULT_PERSONA=<a server-safe, user-facing persona> — 'concierge' is the ` +
    `end-user-facing default, 'executor' the plan-driving one — or give the bot an explicit ` +
    `${TOKEN_PREFIX}<PERSONA_ID> for a persona that qualifies.`
  );
}

/** Allowlist + server-safety + backend checks for one bot. Throws to refuse boot. */
async function validateBot(bot: PersonaBotConfig): Promise<void> {
  const suffix = personaEnvSuffix(bot.personaId);
  const fix = bot.fromLegacyToken ? legacyFix(bot.personaId) : "";

  if (bot.allowedUsers.length === 0) {
    throw new Error(
      `No allowed users for the '${bot.personaId}' bot — refusing to start. Nobody has linked ` +
        "a Discord account in Settings → Discord, and neither " +
        `DISCORD_ALLOWED_USERS_${suffix} nor DISCORD_ALLOWED_USERS is set. Persona conversations ` +
        "can spawn agent runs with full shell/fs access; an explicit allowlist of Discord user " +
        "ids is mandatory."
    );
  }

  const persona = await repo.getPersona(bot.personaId);
  if (!persona) {
    // Discovery resolved the id from the personas table, so this is a delete
    // racing boot rather than a typo — still a hard stop.
    throw new Error(`Persona '${bot.personaId}' not found — refusing to start the pipe.`);
  }

  const unsafe = serverUnsafeProfiles(persona.toolsProfile);
  if (unsafe.length > 0) {
    throw new Error(
      `Persona '${bot.personaId}' has tools profile '${persona.toolsProfile}', which is not ` +
        `server-safe (${unsafe.join(", ")}) — refusing to start. Discord persona conversations ` +
        `are runtime='server' runs: their turns execute inside the pipe process, so shell, ` +
        `filesystem and repo-write tools are not available there (design §3/§6). Server-safe ` +
        `profiles: ${listServerSafeProfiles().join(", ")}. Give the persona an orchestration-only ` +
        `profile (it can still spawn containerized worker runs), or drop its bot token.` +
        fix
    );
  }

  // No backend check any more: a persona carries no engine (migration 0031).
  // The pipe pins backend 'pi' on every conversation run it creates
  // (lib/pipe/session-store.ts), which is the only engine the in-process
  // postgres-turn loop supports, so no deployment default can break a bot.
}

/**
 * The same three checks `validateBot` enforces, reported as a list instead of
 * thrown. This is the form Settings → Discord needs: a bot the operator is
 * still assembling should be FLAGGED in the UI, not turned into a 500.
 *
 * Deliberately worded for the UI (no env-var names, no legacy fix line) —
 * validateBot keeps the boot-refusal prose, which names the env lever the
 * deployment actually has.
 */
export async function botProblems(bot: PersonaBotConfig): Promise<string[]> {
  const problems: string[] = [];

  if (bot.allowedUsers.length === 0) {
    problems.push(
      "Nobody can talk to this bot yet: no one has linked a Discord account in Settings and " +
        "DISCORD_ALLOWED_USERS is unset. Persona conversations can spawn agent runs with full " +
        "shell/fs access, so an explicit allowlist is mandatory."
    );
  }

  const persona = await repo.getPersona(bot.personaId);
  if (!persona) {
    problems.push(`Persona '${bot.personaId}' no longer exists.`);
    return problems;
  }

  const unsafe = serverUnsafeProfiles(persona.toolsProfile);
  if (unsafe.length > 0) {
    problems.push(
      `Persona '${bot.personaId}' has tools profile '${persona.toolsProfile}', which is not ` +
        `server-safe (${unsafe.join(", ")}). Discord persona conversations run inside the pipe ` +
        `process, so shell, filesystem and repo-write tools are unavailable there. Server-safe ` +
        `profiles: ${listServerSafeProfiles().join(", ")}.`
    );
  }

  return problems;
}

/** One configured DB bot plus the validation verdict Settings renders. */
export interface DiscordBotStatus {
  personaId: string;
  personaName: string | null;
  enabled: boolean;
  applicationId: string | null;
  /** Last 4 characters of the stored token; the full value never leaves here. */
  tokenLast4: string;
  /** Who may talk to the bot: linked identities ∪ the DISCORD_ALLOWED_USERS env. */
  allowedUsers: string[];
  /** How many of those came from a user linking their own id in Settings. */
  linkedUserCount: number;
  allowedChannels: string[];
  problems: string[];
  updatedAt: string;
}

/**
 * Every DB-configured bot with its effective allowlist and validation problems.
 * Powers GET /api/discord/bots — the web server has no pipe process to ask, so
 * it recomputes the same verdict the pipe would reach at boot.
 */
export async function discordBotStatuses(env: Env = process.env): Promise<DiscordBotStatus[]> {
  const [rows, personas, linked] = await Promise.all([
    repo.listDiscordBots(),
    repo.listPersonas(),
    repo.listChannelIdentityExternalIds("discord"),
  ]);
  const nameById = new Map(personas.map((p) => [p.id, p.name]));
  const envChannels = csv(env.DISCORD_ALLOWED_CHANNELS);

  const out: DiscordBotStatus[] = [];
  for (const row of rows) {
    const allowedUsers = [
      ...new Set([
        ...linked,
        ...csv(env.DISCORD_ALLOWED_USERS),
        ...csv(env[`DISCORD_ALLOWED_USERS_${personaEnvSuffix(row.personaId)}`]),
      ]),
    ];
    const bot: PersonaBotConfig = {
      personaId: row.personaId,
      token: row.token,
      source: "db",
      allowedUsers,
      allowedChannels: row.allowedChannels.length ? row.allowedChannels : envChannels,
      applicationId: row.applicationId ?? undefined,
    };
    out.push({
      personaId: row.personaId,
      personaName: nameById.get(row.personaId) ?? null,
      enabled: row.enabled,
      applicationId: row.applicationId,
      tokenLast4: row.token.slice(-4),
      allowedUsers,
      linkedUserCount: linked.length,
      allowedChannels: bot.allowedChannels,
      problems: await botProblems(bot),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return out;
}

function str(v: string | undefined): string | undefined {
  const s = (v ?? "").trim();
  return s ? s : undefined;
}

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Per-bot override when the var is set to a non-empty list, else the global. */
function csvOr(v: string | undefined, fallback: string[]): string[] {
  const own = csv(v);
  return own.length ? own : fallback;
}
