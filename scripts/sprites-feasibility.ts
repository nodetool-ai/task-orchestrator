// scripts/sprites-feasibility.ts
// Spike S1/S2/S3 feasibility script for Sprites.
// Modelled on scripts/fly-channel-probe.ts. Requires a real SPRITES_TOKEN; operator-run, not CI.
//
// Usage:
//   SPRITES_TOKEN=... npx tsx scripts/sprites-feasibility.ts
//   or: TASK_ORCH_SPRITES_WORKER_BUNDLE_URL=... SPRITES_TOKEN=... npm run spike:sprites
//
// The script creates one disposable sprite, exercises S1/S2/S3, and always
// deletes the sprite in a finally block.

import { setTimeout as delay } from "node:timers/promises";

import { makeSpritesClient } from "../lib/runner/sprites-client";
import { openSpritesProxyTunnel, spritesProxyUrl } from "../lib/runner/sprites-tunnel";

const TOKEN = process.env.SPRITES_TOKEN ?? process.env.TASK_ORCH_SPRITES_TOKEN;
const BASE_URL = process.env.TASK_ORCH_SPRITES_BASE_URL ?? process.env.SPRITES_BASE_URL ?? "https://api.sprites.dev/v1";

function log(...args: unknown[]): void {
  console.log(`[spike ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

type SpikeResult = { spike: string; item: string; result: "PASS" | "FAIL" | "INFO"; notes: string };

const results: SpikeResult[] = [];
function record(spike: string, item: string, result: SpikeResult["result"], notes: string): void {
  results.push({ spike, item, result, notes });
  log(`${spike} ${item}: ${result} — ${notes}`);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("Refusing to run: set SPRITES_TOKEN (or TASK_ORCH_SPRITES_TOKEN). This creates a real sprite.");
    process.exit(2);
  }

  const client = makeSpritesClient({ token: TOKEN, baseUrl: BASE_URL });
  const spriteName = `to-spike-${Date.now()}`;
  log(`creating sprite ${spriteName} via ${BASE_URL}`);
  let created = false;

  // Summary tracking
  const summary = (label: string, fn: () => Promise<void>) => fn().catch((err) => {
    log(`ERROR in ${label}:`, err instanceof Error ? err.message : String(err));
    record(label.split(" ")[0], label, "FAIL", err instanceof Error ? err.message.slice(0, 200) : String(err));
  });

  try {
    await client.createSprite({ name: spriteName, urlSettings: { auth: "sprite" } });
    created = true;
    log(`sprite ${spriteName} created`);

    // ── S3: base image audit ──────────────────────────────────────────────
    await summary("S3 node --version", async () => {
      const r = await client.exec(spriteName, { cmd: "node --version" });
      const out = (r.stdout || "").trim();
      log(`node --version: ${out || "(empty)"} exit=${r.exitCode}`);
      record("S3", "node --version", r.exitCode === 0 ? "PASS" : "FAIL", out);
    });
    await summary("S3 git --version", async () => {
      const r = await client.exec(spriteName, { cmd: "git --version" });
      const out = (r.stdout || "").trim();
      log(`git --version: ${out} exit=${r.exitCode}`);
      record("S3", "git --version", r.exitCode === 0 ? "PASS" : "FAIL", out);
    });
    await summary("S3 python3 --version", async () => {
      const r = await client.exec(spriteName, { cmd: "python3 --version" });
      const out = ((r.stdout || r.stderr) || "").trim();
      log(`python3 --version: ${out} exit=${r.exitCode}`);
      record("S3", "python3 --version", r.exitCode === 0 ? "PASS" : "FAIL", out);
    });
    await summary("S3 which tools", async () => {
      const r = await client.exec(spriteName, { cmd: "which ffmpeg pandoc pdftotext rg jq; echo ---; ffmpeg -version 2>&1 | head -n1; pandoc --version 2>&1 | head -n1" });
      const out = (r.stdout || "").trim();
      log(`which/tools:\n${out}`);
      // Compare against Dockerfile.fly-runner apt list
      const aptList = ["git", "curl", "ripgrep", "fd-find", "jq", "ffmpeg", "zip", "unzip", "poppler-utils", "qpdf", "pandoc", "postgresql-client", "python3", "gh"];
      const missing = aptList.filter((bin) => !out.includes(bin));
      // We check for presence of requested binaries
      const whichOut = out.split("\n").slice(0, 5).join(" ");
      record("S3", "which ffmpeg pandoc pdftotext rg jq", out.includes("ffmpeg") ? "PASS" : "INFO", whichOut.slice(0, 200));
      if (missing.length) {
        log(`delta vs Dockerfile.fly-runner: possibly missing ${missing.join(", ")} (check actual which output)`);
      }
    });

    // ── S3 timing: checkpoint / restore ───────────────────────────────────
    await summary("S3 checkpoint", async () => {
      const start = Date.now();
      const cp = await client.checkpoint(spriteName, `spike ${Date.now()}`);
      const dur = Date.now() - start;
      log(`checkpoint ${cp.id} in ${dur}ms`);
      record("S3", "checkpoint", "INFO", `${cp.id} ${dur}ms`);
      const startR = Date.now();
      await client.restoreCheckpoint(spriteName, cp.id);
      const durR = Date.now() - startR;
      log(`restoreCheckpoint ${cp.id} in ${durR}ms`);
      record("S3", "restoreCheckpoint", "INFO", `${durR}ms`);
    });

    // ── S2: proxy tunneling ───────────────────────────────────────────────
    // Define echo service
    await summary("S2 putService echo", async () => {
      await client.putService(spriteName, "echo", {
        cmd: "node",
        args: ["-e", "require('net').createServer(s=>s.pipe(s)).listen(8787)"],
        dir: "/home/user",
      });
      log(`putService echo defined`);
    });
    await summary("S2 startService echo", async () => {
      await client.startService(spriteName, "echo");
      log(`startService echo`);
      await delay(3000);
    });

    let tunnel: import("node:stream").Duplex | undefined;
    let s2FirstRt: number | undefined;
    let s2SecondOk = false;
    let s2SecondErr = "";

    await summary("S2 proxy echo", async () => {
      const start = Date.now();
      tunnel = await openSpritesProxyTunnel({ spriteName, port: 8787 }, { token: TOKEN, proxyUrl: spritesProxyUrl(spriteName, BASE_URL) });
      log(`proxy tunnel opened`);
      const payload = Buffer.from("ping");
      const rtStart = Date.now();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("echo timeout 5s")), 5000);
        const onData = (chunk: Buffer) => {
          const s = chunk.toString();
          if (s.includes("ping")) {
            clearTimeout(timer);
            tunnel!.off("data", onData);
            resolve();
          }
        };
        tunnel!.on("data", onData);
        tunnel!.write(payload);
      });
      s2FirstRt = Date.now() - rtStart;
      log(`echo round-trip ${s2FirstRt}ms`);
      record("S2", "proxy echo RT", "PASS", `${s2FirstRt}ms`);
      log(`waiting 60s with tunnel idle...`);
      await delay(60_000);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("echo timeout 5s after idle")), 5000);
          const onData = (chunk: Buffer) => {
            if (chunk.toString().includes("ping")) {
              clearTimeout(timer);
              tunnel!.off("data", onData);
              resolve();
            }
          };
          tunnel!.on("data", onData);
          tunnel!.write(Buffer.from("ping"));
        });
        s2SecondOk = true;
        log(`second echo after 60s idle succeeded`);
        record("S2", "idle 60s tunnel", "PASS", "still works");
      } catch (err) {
        s2SecondErr = err instanceof Error ? err.message : String(err);
        log(`second echo after 60s idle failed: ${s2SecondErr}`);
        record("S2", "idle 60s tunnel", "FAIL", s2SecondErr);
      }
      log(`S2 first RT ${s2FirstRt}ms, second idle ${s2SecondOk ? "ok" : `failed: ${s2SecondErr}`}`);
    });

    // ── S1: hibernation semantics ──────────────────────────────────────────
    await summary("S1 hibernation", async () => {
      if (tunnel) {
        try { tunnel.destroy(); } catch {}
        tunnel = undefined;
      }
      log(`closed tunnel, waiting 90s for hibernate...`);
      await delay(90_000);
      const sprite = await client.getSprite(spriteName);
      const status = sprite?.status ?? "(missing)";
      log(`getSprite status after 90s idle: ${status} (expect cold)`);
      record("S1", "status after 90s idle", status === "cold" ? "PASS" : "INFO", status);
      const wakeStart = Date.now();
      try {
        tunnel = await openSpritesProxyTunnel({ spriteName, port: 8787 }, { token: TOKEN, proxyUrl: spritesProxyUrl(spriteName, BASE_URL) });
        const wakeMs = Date.now() - wakeStart;
        log(`cold-wake re-dial succeeded in ${wakeMs}ms`);
        record("S1", "cold-wake latency", "INFO", `${wakeMs}ms`);

        // Use a new tunnel for the pgrep check via exec (not via proxy)
        const r = await client.exec(spriteName, { cmd: "pgrep -f createServer || echo no-proc" });
        const out = (r.stdout || "").trim();
        log(`pgrep -f createServer: ${out}`);
        record("S1", "service survived hibernate", out.includes("no-proc") ? "INFO" : "PASS", out.slice(0, 200));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`re-dial after hibernate failed: ${msg}`);
        record("S1", "cold-wake latency", "FAIL", msg);
      }
    });

  } finally {
    if (created) {
      log(`deleting sprite ${spriteName}...`);
      try {
        await client.deleteSprite(spriteName);
        log(`deleted sprite ${spriteName}`);
      } catch (err) {
        console.error(`FAILED to delete sprite ${spriteName}:`, err instanceof Error ? err.message : err);
      }
    }
    // Summary table
    console.log("\n=== SPIKE SUMMARY ===");
    console.log("| Spike | Item | Result | Notes |");
    console.log("|-------|------|--------|-------|");
    for (const r of results) {
      console.log(`| ${r.spike} | ${r.item} | ${r.result} | ${r.notes.replace(/\|/g, "\\|").slice(0, 120)} |`);
    }
    if (results.length === 0) console.log("| (none) | — | INFO | No results (sprite create failed) |");
    console.log("=== END SUMMARY ===\n");
    console.log("Paste this table into docs/sprites-migration-design.md §10.1 Phase 0 findings.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
