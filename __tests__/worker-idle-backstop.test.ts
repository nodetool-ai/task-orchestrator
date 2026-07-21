import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { mintChannelCredential } from "../lib/worker-channel/credential";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { WORKER_CHANNEL_PROTOCOL, WORKER_CHANNEL_SUBPROTOCOL } from "../lib/worker-channel/protocol";
import { decodeFrame, encodeFrame } from "../lib/worker-channel/codec";

// Run 169: the worker bound its listener, the control plane's boot deadline
// expired before it could dial, and the Machine then sat started-and-idle at
// full price with nothing able to stop it. The worker needs its own backstop.
const servers: WorkerServer[] = [];
const roots: string[] = [];
const secret = "idle-backstop-secret";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeServer(idleExitMs: number, onIdleExit: (reason: string) => void) {
  const root = await mkdtemp(join(tmpdir(), "idle-backstop-"));
  roots.push(root);
  const runId = 91;
  const instanceId = `wi_${"d".repeat(32)}`;
  const token = mintChannelCredential(runId, instanceId, { secret });
  const server = await startWorkerServer({
    runId,
    instanceId,
    credential: token,
    credentialSecret: secret,
    outboxRoot: root,
    endpoint: "tcp:127.0.0.1:0",
    idleExitMs,
    onIdleExit,
  });
  servers.push(server);
  return { server, token };
}

function url(server: WorkerServer): string {
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no tcp bind");
  return `ws://127.0.0.1:${a.port}/worker/channel`;
}

/** Open a socket AND complete the handshake. Only a fully attached controller
 *  disarms the backstop — a socket that connects and never sends channel.accept
 *  is itself a dead controller and must not keep the worker alive. */
async function attachController(server: WorkerServer, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url(server), WORKER_CHANNEL_SUBPROTOCOL, {
    headers: { authorization: `Bearer ${token}` },
  });
  const hello = new Promise<void>((res, rej) => {
    socket.once("message", (raw: Buffer) => {
      const frame = decodeFrame(raw);
      frame.type === "channel.hello" ? res() : rej(new Error(`got ${frame.type}`));
    });
    socket.once("error", rej);
  });
  await new Promise<void>((res, rej) => {
    socket.once("open", () => res());
    socket.once("error", rej);
  });
  await hello;
  socket.send(
    encodeFrame({
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.accept",
      seq: 0,
      payload: {
        protocol: WORKER_CHANNEL_PROTOCOL,
        controllerEpoch: 1,
        leaseId: "idle-backstop",
        lastAcceptedWorkerSeq: 0,
        heartbeatMs: 10_000,
        disconnectGraceMs: 60_000,
        maxInFlightBytes: 8 * 1024 * 1024,
      },
    } as never)
  );
  return socket;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("worker idle backstop", () => {
  it("fires when the worker binds but is NEVER dialed (the run-169 hole)", async () => {
    const fired: string[] = [];
    await makeServer(120, (reason) => void fired.push(reason));
    await tick(400);
    expect(fired.length).toBe(1);
    expect(fired[0]).toContain("no controller attached");
  });

  it("does NOT fire while a controller is attached", async () => {
    const fired: string[] = [];
    const { server, token } = await makeServer(150, (reason) => void fired.push(reason));
    const socket = await attachController(server, token);
    await tick(500); // well past the deadline
    expect(fired).toEqual([]);
    socket.close();
  });

  it("re-arms once the controller goes away", async () => {
    const fired: string[] = [];
    const { server, token } = await makeServer(150, (reason) => void fired.push(reason));
    const socket = await attachController(server, token);
    await tick(250);
    expect(fired).toEqual([]);
    socket.close();
    await tick(600);
    expect(fired.length).toBe(1);
  });

  it("stays disabled when idleExitMs is 0 (embedded servers, tests, dev)", async () => {
    const fired: string[] = [];
    await makeServer(0, (reason) => void fired.push(reason));
    await tick(400);
    expect(fired).toEqual([]);
  });
});
