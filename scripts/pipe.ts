#!/usr/bin/env node
// scripts/pipe.ts
//
// Entrypoint for the channel bridge (`npm run pipe`). A standalone, opt-in
// long-running process that connects Discord to the existing task-orchestrator
// agent runtime. Mirrors cli.ts: load dotenv BEFORE importing any lib/* or @/db
// so env is set when the DB initialises and migrations (incl. 0018) run.
//
// OPERATIONAL NOTE (M5). This process is now REQUIRED for persona threads to
// make noise. A run that a channel_threads row points at no longer gets woken by
// the web process (lib/run-dispatch.ts defers it): its milestone turn has to run
// where the Discord draft is, which is here. Inbox events for those runs are
// durable and simply stay pending while the pipe is down — nothing is lost, but
// nothing is narrated either, until it comes back and the wake pump picks them
// up (one poll interval, TASK_ORCH_PIPE_RELAY_POLL_MS).

import { config } from "dotenv";
config({ path: ".env.local" });

import { createServer, type Server } from "node:http";

import "../db"; // triggers migrations (incl. 0019_agent_runs_heartbeat) on import
import { config as appConfig } from "../lib/config";
import { ChannelManager } from "../lib/pipe/channel-manager";
import { DiscordChannel } from "../lib/pipe/channels/discord";
import { loadPipeConfig } from "../lib/pipe/config";
import { ProgressRelay } from "../lib/pipe/relay";
import { reconcileOrphanedRuns } from "../lib/runs";
import { telemetry } from "../lib/runner/telemetry";

/**
 * Optional Prometheus listener (`TASK_ORCH_PIPE_METRICS_PORT`, off by default).
 *
 * The PRD §11 messaging metrics are emitted HERE — in the pipe process — so the
 * web app's /api/metrics, which serves the same prom-client registry from a
 * different process, cannot see them. This exposes that registry on loopback in
 * the same exposition format, under the same metric names, for a local scraper
 * or a sidecar. Bound to 127.0.0.1 deliberately: the pipe holds bot tokens and
 * has no auth layer, so nothing it serves should be reachable off-box.
 */
function startMetricsServer(): Server | undefined {
  const port = appConfig.pipe.metricsPort;
  if (port <= 0) return undefined;
  const registry = telemetry().registry;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || !req.url?.startsWith("/metrics")) {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { "Content-Type": registry.contentType, "Cache-Control": "no-store" });
        res.end(body);
      })
      .catch(() => res.writeHead(500).end());
  });
  server.on("error", (err) => console.error("[pipe] metrics listener failed:", err));
  server.listen(port, "127.0.0.1", () =>
    console.log(`[pipe] metrics on http://127.0.0.1:${port}/metrics`)
  );
  return server;
}

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

  // One (DiscordChannel, AgentLoop) pair per persona bot, all in this process
  // (design §1). ChannelManager builds the loops and starts every gateway
  // client concurrently; stop() destroys all of them.
  const cfg = await loadPipeConfig();
  const channels = cfg.bots.map((bot) => new DiscordChannel(bot));
  // The breadcrumb relay is constructed HERE, from the channels array, rather
  // than inside ChannelManager: it needs the channel handles (to post into a
  // thread) and the manager deliberately does not expose them — it owns loops,
  // not transports. The relay is handed back to the manager so the agent loops
  // can ask it what a reacted-to breadcrumb was about (❌ = cancel that run).
  const relay = new ProgressRelay(channels);
  const manager = new ChannelManager(channels, cfg, relay);

  await manager.start();
  relay.start();
  const metricsServer = startMetricsServer();
  console.log(`[pipe] ready — ${cfg.bots.map((b) => b.personaId).join(", ")}`);

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pipe] ${sig} — shutting down`);
    relay.stop();
    metricsServer?.close();
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
