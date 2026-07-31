// lib/pipe/config.ts
//
// Load the channel-bridge config from the environment. Follows the project's
// TASK_ORCH_* / dotenv convention (see cli.ts and .env.example).
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

import { resolveBackendId } from "@/lib/agent-backend";
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

  const bots = discoverBots(env, bySuffix);
  if (bots.length === 0) {
    throw new Error(
      "No Discord bot tokens found — refusing to start. Set DISCORD_BOT_TOKEN_<PERSONA_ID> " +
        `(e.g. DISCORD_BOT_TOKEN_${personaEnvSuffix(DEFAULT_PERSONA_ID)}) for each persona bot, ` +
        "or the legacy DISCORD_BOT_TOKEN for a single-bot deployment."
    );
  }
  for (const bot of bots) await validateBot(bot);

  // The DISCORD_* vars come from `env` (injectable, so discovery is testable
  // without mutating the process environment); the TASK_ORCH_* tunables come
  // from lib/config, which is the one place allowed to read them (R6 guard).
  return {
    bots,
    defaultModel: config.agent.chatModel ?? "openai/gpt-5.6-sol",
    editThrottleMs: config.pipe.editThrottleMs,
  };
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
    `DISCORD_DEFAULT_PERSONA=<a server-safe, user-facing persona> — 'executor' today, ` +
    `'concierge' once it ships — or give the bot an explicit ` +
    `${TOKEN_PREFIX}<PERSONA_ID> for a persona that qualifies.`
  );
}

/** Allowlist + server-safety + backend checks for one bot. Throws to refuse boot. */
async function validateBot(bot: PersonaBotConfig): Promise<void> {
  const suffix = personaEnvSuffix(bot.personaId);
  const fix = bot.fromLegacyToken ? legacyFix(bot.personaId) : "";

  if (bot.allowedUsers.length === 0) {
    throw new Error(
      `No allowed users for the '${bot.personaId}' bot (DISCORD_ALLOWED_USERS_${suffix} or ` +
        "DISCORD_ALLOWED_USERS) — refusing to start. Persona conversations can spawn agent runs " +
        "with full shell/fs access; an explicit allowlist of Discord user ids is mandatory."
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

  let backend: string;
  try {
    backend = resolveBackendId(persona.backend);
  } catch (err) {
    throw new Error(
      `Persona '${bot.personaId}' has an invalid backend — refusing to start: ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (backend !== "pi") {
    throw new Error(
      `Persona '${bot.personaId}' resolves to the '${backend}' backend — refusing to start. ` +
        "Discord persona conversations run in-process through the pi-only postgres-turn loop; " +
        "the Claude backend rejects contextSource='postgres'. Set backend 'pi' on the persona, " +
        "or change the deployment default (TASK_ORCH_AGENT_BACKEND)." +
        fix
    );
  }
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
