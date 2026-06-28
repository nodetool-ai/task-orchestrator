#!/usr/bin/env node
// scripts/pipe.ts
//
// Entrypoint for the channel bridge (`npm run pipe`). A standalone, opt-in
// long-running process that connects Discord to the existing task-orchestrator
// agent runtime. Mirrors cli.ts: load dotenv BEFORE importing any lib/* or @/db
// so env is set when the DB initialises and migrations (incl. 0018) run.

import { config } from "dotenv";
config({ path: ".env.local" });

import "../db"; // triggers migrations (incl. 0018_channel_threads) on import
import { ChannelManager } from "../lib/pipe/channel-manager";
import { DiscordChannel } from "../lib/pipe/channels/discord";
import { loadPipeConfig } from "../lib/pipe/config";

async function main() {
  const cfg = loadPipeConfig();
  const discord = new DiscordChannel(cfg.discord);
  const manager = new ChannelManager([discord], cfg);

  await manager.start();
  console.log("[pipe] ready");

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pipe] ${sig} — shutting down`);
    await manager.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("[pipe] fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
