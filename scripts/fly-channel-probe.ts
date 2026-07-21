// scripts/fly-channel-probe.ts
//
// Provision ONE disposable Fly runner Machine, dial its worker channel as the
// control plane, and tear everything down. No Postgres, no runner_instances
// row — it speaks the wire protocol directly (same approach as
// scripts/worker-chat.ts), so nothing here touches production run state.
//
// Usage:
//   FLY_API_TOKEN=... TASK_ORCH_FLY_APP=task-orchestrator-runners \
//   FLY_RUNNER_IMAGE=registry.fly.io/task-orchestrator-runners:latest \
//   TASK_ORCH_FLY_PROBE=1 npx tsx scripts/fly-channel-probe.ts
//
// The volume is deliberately NOT named vol_run_* so the orphan reaper
// (isReapableVolume) can never adopt it.
import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

/** Read the machine's listening sockets straight from /proc. 8787 == 0x2253,
 *  state 0A == TCP_LISTEN. */
async function inspectSockets(machineId: string): Promise<{ v4: boolean; v6: boolean }> {
  const { stdout } = await execFileAsync("fly", [
    "ssh",
    "console",
    "-a",
    String(process.env.TASK_ORCH_FLY_APP),
    "--machine",
    machineId,
    "-C",
    "sh -c 'echo V4; cat /proc/net/tcp; echo V6; cat /proc/net/tcp6'",
  ]);
  console.log("----- raw /proc/net dump from the machine -----");
  console.log(stdout.trim());
  console.log("----------------------------------------------");
  const [v4Block = "", v6Block = ""] = stdout.split(/^V6$/m).map((s) => s.replace(/^V4$/m, ""));
  const listens = (block: string) =>
    block.split("\n").some((line) => /:2253\s/.test(line) && /\s0A\s/.test(line));
  return { v4: listens(v4Block), v6: listens(v6Block) };
}

import { buildFlyMachineConfig } from "../lib/runner/fly";
import { makeFlyClient } from "../lib/runner/fly-client";
import { newChannelInstanceId } from "../lib/worker-channel/credential";
import { flyChannelDialEndpoint, flyListenEndpoint } from "../lib/worker-channel/dispatch-env";

const PROBE_RUN_ID = 999_000 + Math.floor(Date.now() / 1000) % 1000;
const REGION = process.env.TASK_ORCH_FLY_REGION || "ams";
const SUBPROTOCOL = "task-orchestrator.worker.v1";
const PROTOCOL = 1;

function log(...args: unknown[]): void {
  console.log(`[probe ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.TASK_ORCH_FLY_PROBE !== "1") {
    console.error("Refusing to run: set TASK_ORCH_FLY_PROBE=1 (this creates a real Fly Machine).");
    process.exit(2);
  }

  const fly = makeFlyClient();
  const instanceId = newChannelInstanceId();
  // An opaque credential: worker-server compares config.credential literally
  // when injected, so no signing secret is needed.
  const credential = `probe.${randomBytes(24).toString("base64url")}`;
  const suffix = randomBytes(4).toString("hex");

  let volumeId: string | undefined;
  let machineId: string | undefined;
  let socket: WebSocket | undefined;
  let proxy: ChildProcess | undefined;

  try {
    log(`creating volume probe_ws_${suffix} in ${REGION}`);
    const volume = await fly.createVolume({ name: `probe_ws_${suffix}`, region: REGION, size_gb: 1 });
    volumeId = volume.id;
    log(`volume ${volumeId}`);

    const base = await buildFlyMachineConfig(PROBE_RUN_ID, volume.id, {
      channelInstanceId: instanceId,
      channelListenEndpoint: flyListenEndpoint(),
    });
    const config = {
      ...base,
      env: { ...base.env, TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: credential },
    };
    log(`listen endpoint the worker is told to bind: ${flyListenEndpoint()}`);

    // A freshly created volume is briefly unmountable ("volume not found").
    log("waiting for the volume to become mountable");
    for (let i = 0; i < 30; i++) {
      const vols = await fly.listVolumes();
      const mine = vols.find((v) => v.id === volumeId);
      if (mine && mine.state !== "creating" && mine.state !== "pending") break;
      await delay(2_000);
    }

    log("creating machine");
    let machine: Awaited<ReturnType<typeof fly.createMachine>> | undefined;
    for (let i = 0; ; i++) {
      try {
        machine = await fly.createMachine({ name: `probe-ws-${suffix}`, region: REGION, config });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (i >= 10 || !/volume not found/i.test(msg)) throw e;
        log(`  volume not mountable yet; retrying (${i + 1}/10)`);
        await delay(3_000);
      }
    }
    machineId = machine!.id;
    log(`machine ${machineId}`);

    // Wait for a started machine with a private IP.
    let privateIp: string | undefined;
    const bootDeadline = Date.now() + 180_000;
    for (;;) {
      const m = await fly.getMachine(machineId!);
      if (m?.state === "started" && m.privateIp) {
        privateIp = m.privateIp;
        break;
      }
      if (Date.now() > bootDeadline) throw new Error(`machine never started (last state ${m?.state})`);
      await delay(3_000);
    }
    log(`started, private 6PN IP ${privateIp}`);

    // ── Evidence: what did the worker ACTUALLY bind? ────────────────────────
    // 8787 = 0x2253. A listener shows as `<addr>:2253 ... 0A` (0A = TCP_LISTEN).
    // /proc/net/tcp is IPv4, /proc/net/tcp6 is IPv6. The control plane dials the
    // 6PN IPv6 address, so an IPv4-only listener is unreachable.
    log("waiting 45s for the worker to boot, then inspecting its listening sockets");
    await delay(45_000);
    const sockets = await inspectSockets(machineId!);
    log(`  IPv4 listener on 8787: ${sockets.v4 ? "YES" : "no"}`);
    log(`  IPv6 listener on 8787: ${sockets.v6 ? "YES" : "no"}`);
    if (sockets.v4 && !sockets.v6) {
      log("  ^ IPv4-only. The control plane dials ws://[fdaa:...]:8787 → ECONNREFUSED.");
    }

    // Dial through a local WireGuard proxy: a laptop cannot route 6PN directly.
    const localPort = 18787 + (Date.now() % 1000);
    log(`starting: fly proxy ${localPort}:8787 ${privateIp} -a ${process.env.TASK_ORCH_FLY_APP}`);
    proxy = spawn(
      "fly",
      ["proxy", `${localPort}:8787`, privateIp!, "-a", String(process.env.TASK_ORCH_FLY_APP), "-q"],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    await delay(5_000);

    const endpoint = `ws://127.0.0.1:${localPort}/worker/channel`;
    log(`dialing ${endpoint} (proxied to [${privateIp}]:8787)`);

    const deadline = Date.now() + 120_000;
    let lastError = "";
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`timed out dialing ${endpoint} — last error: ${lastError}`);
      }
      const attempt = new WebSocket(endpoint, [SUBPROTOCOL], {
        headers: { Authorization: `Bearer ${credential}` },
        handshakeTimeout: 5_000,
      });
      const outcome = await new Promise<string>((resolve) => {
        attempt.once("open", () => resolve("open"));
        attempt.once("error", (e: Error) => resolve(e.message));
      });
      if (outcome === "open") {
        socket = attempt;
        break;
      }
      lastError = outcome;
      attempt.terminate();
      log(`  not up yet (${outcome}); retrying`);
      await delay(2_000);
    }
    log("WebSocket upgrade accepted — path, subprotocol and credential all OK");

    // The worker speaks first: channel.hello.
    const hello = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no channel.hello within 15s")), 15_000);
      socket!.once("message", (data: Buffer) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.toString()));
        } catch (e) {
          reject(new Error(`channel.hello was not JSON: ${String(e)}`));
        }
      });
    });
    if (hello?.type !== "channel.hello") throw new Error(`expected channel.hello, got ${hello?.type}`);
    log(`channel.hello received: protocol ${JSON.stringify(hello.payload?.protocol)} build ${hello.payload?.workerBuild}`);

    socket!.send(
      JSON.stringify({
        v: PROTOCOL,
        type: "channel.accept",
        seq: 0,
        payload: {
          protocol: PROTOCOL,
          controllerEpoch: 1,
          leaseId: `probe-${suffix}`,
          lastAcceptedWorkerSeq: 0,
          heartbeatMs: 10_000,
          disconnectGraceMs: 60_000,
          maxInFlightBytes: 8_388_608,
        },
      })
    );
    log("channel.accept sent; settling for 3s to confirm the worker does not reject");

    let closed = "";
    socket!.once("close", (code: number, reason: Buffer) => {
      closed = `${code} ${reason?.toString() ?? ""}`;
    });
    await delay(3_000);
    if (closed) throw new Error(`worker closed the channel after accept: ${closed}`);
    if (socket!.readyState !== WebSocket.OPEN) throw new Error("socket is no longer open after accept");

    log("");
    log("RESULT: PASS — full control-plane handshake completed against a real Fly Machine.");
  } finally {
    log("tearing down");
    try {
      socket?.close();
    } catch {}
    try {
      proxy?.kill();
    } catch {}
    if (machineId) {
      await makeFlyClient()
        .destroyMachine(machineId, { force: true })
        .then(() => log(`destroyed machine ${machineId}`))
        .catch((e) => console.error(`FAILED to destroy machine ${machineId}:`, e));
    }
    if (volumeId) {
      // The machine must be gone before its volume can be released.
      await delay(2_000);
      await makeFlyClient()
        .destroyVolume(volumeId)
        .then(() => log(`destroyed volume ${volumeId}`))
        .catch((e) => console.error(`FAILED to destroy volume ${volumeId}:`, e));
    }
  }
}

main().catch((e) => {
  console.error("");
  console.error("RESULT: FAIL —", e instanceof Error ? e.message : e);
  process.exit(1);
});
