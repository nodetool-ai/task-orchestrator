#!/usr/bin/env node
// scripts/pipe.ts
//
// Entrypoint for the channel bridge (`npm run pipe`). A standalone, opt-in
// long-running process that connects Discord to the existing task-orchestrator
// agent runtime. Mirrors cli.ts: load dotenv BEFORE importing any lib/* or @/db
// so env is set when the DB initialises and migrations (incl. 0018) run.

import { config } from "dotenv";
config({ path: ".env.local" });

import "../db"; // triggers migrations (incl. 0019_agent_runs_heartbeat) on import
import { ChannelManager } from "../lib/pipe/channel-manager";
import { DiscordChannel } from "../lib/pipe/channels/discord";
import { loadPipeConfig } from "../lib/pipe/config";
import { reconcileOrphanedRuns } from "../lib/runs";

async function main() {
  // Self-heal runs left "in flight" by a previous process that died mid-turn
  // (e.g. OOM-killed): without this they'd stay stuck and reject every message.
  // Awaited so stuck runs are healed before the bridge accepts messages; a
  // transient DB failure must not crash the process as an unhandled rejection.
  try {
    await reconcileOrphanedRuns();
  } catch (err) {
    console.error("[pipe] orphaned-run reconciliation failed:", err);
  }

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
