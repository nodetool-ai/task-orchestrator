// lib/discord-bots.ts
//
// The wire shape Settings → Discord sees. Separate from the route handlers
// because two of them return it (the list and the per-bot PATCH), and separate
// from lib/pipe/config.ts because that module is the pipe's boot path.

import { inviteUrl } from "./discord-verify";
import type { DiscordBotStatus } from "./pipe/config";

export interface DiscordBotDto {
  personaId: string;
  personaName: string | null;
  enabled: boolean;
  configured: boolean;
  /** Last 4 characters only — see serializeDiscordBot. */
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

/**
 * Mask + flatten one bot for the browser. The token is reduced to its last 4
 * characters HERE and nowhere else: no route returns the stored secret, so a
 * compromised browser session cannot exfiltrate a working bot token.
 */
export function serializeDiscordBot(status: DiscordBotStatus): DiscordBotDto {
  return {
    personaId: status.personaId,
    personaName: status.personaName,
    enabled: status.enabled,
    configured: true,
    tokenLast4: status.tokenLast4,
    applicationId: status.applicationId,
    inviteUrl: status.applicationId ? inviteUrl(status.applicationId) : null,
    allowedUsers: status.allowedUsers,
    linkedUserCount: status.linkedUserCount,
    allowedChannels: status.allowedChannels,
    problems: status.problems,
    valid: status.problems.length === 0,
    updatedAt: status.updatedAt,
  };
}
