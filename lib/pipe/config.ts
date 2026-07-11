// lib/pipe/config.ts
//
// Load the channel-bridge config from the environment. Follows the project's
// TASK_ORCH_* / dotenv convention (see cli.ts and .env.example).
//
// SECURITY: chat runs execute with permissionMode "bypassPermissions" and full
// shell/fs access in the default repo checkout, so an explicit Discord user
// allowlist is mandatory — loadPipeConfig refuses to start without one.

import type { PipeConfig } from "./types";

export function loadPipeConfig(): PipeConfig {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required to run the Discord bridge (npm run pipe).");
  }

  const allowedUsers = csv(process.env.DISCORD_ALLOWED_USERS);
  if (allowedUsers.length === 0) {
    throw new Error(
      "DISCORD_ALLOWED_USERS is empty — refusing to start. The agent runs with " +
        "bypassPermissions and full shell/fs access; an explicit allowlist of Discord " +
        "user ids is mandatory."
    );
  }

  return {
    discord: {
      token,
      allowedUsers,
      allowedChannels: csv(process.env.DISCORD_ALLOWED_CHANNELS),
    },
    defaultModel: process.env.TASK_ORCH_CHAT_MODEL ?? "openai/gpt-5.6-sol",
    editThrottleMs: positiveInt(process.env.TASK_ORCH_PIPE_EDIT_MS, 750),
  };
}

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
