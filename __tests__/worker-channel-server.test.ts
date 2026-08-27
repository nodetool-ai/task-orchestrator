import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { decodeFrame, encodeFrame } from "../lib/worker-channel/codec";
import { mintChannelCredential } from "../lib/worker-channel/credential";
import {
  startWorkerServer,
  type WorkerServer,
  type WorkerSessionLike,
} from "../lib/worker-channel/worker-server";
import {
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type AcceptFrame,
  type ChannelAccept,
  type WorkerCommand,
} from "../lib/worker-channel/protocol";

const servers: WorkerServer[] = [];
const roots: string[] = [];
const secret = "worker-channel-server-test-secret";

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeServer(
  options: Partial<Parameters<typeof startWorkerServer>[0]> = {},
): Promise<{ server: WorkerServer; token: string; instanceId: string }> {
  const root = await mkdtemp(join(tmpdir(), "worker-channel-server-"));
  roots.push(root);
  const runId = 71;
  const instanceId = `wi_${"a".repeat(32)}`;
  const token = mintChannelCredential(runId, instanceId, { secret });
  const server = await startWorkerServer({
    runId,
    instanceId,
    credential: token,
    credentialSecret: secret,
    outboxRoot: root,
    transport: "tcp",
    host: "127.0.0.1",
    port: 0,
    ...options,
  });
  servers.push(server);
  return { server, token, instanceId };
}

function serverUrl(server: WorkerServer): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return `ws://127.0.0.1:${address.port}/worker/channel`;
}

// The worker speaks first and its frames can arrive in the same TCP segment as
// the 101 handshake, so a message listener attached after 'open' would drop the
// hello. Buffer every inbound frame from socket creation instead.
const inboxes = new WeakMap<WebSocket, { data: Buffer[]; waiters: Array<(data: Buffer) => void> }>();

function track(socket: WebSocket): WebSocket {
  const state = { data: [] as Buffer[], waiters: [] as Array<(data: Buffer) => void> };
  inboxes.set(socket, state);
  socket.on("message", (raw: WebSocket.RawData, binary: boolean) => {
    const buffer = binary
      ? Buffer.concat(Array.isArray(raw) ? raw : [raw as Buffer])
      : (raw as Buffer);
    const waiter = state.waiters.shift();
    if (waiter) waiter(buffer);
    else state.data.push(buffer);
  });
  return socket;
}

function connect(server: WorkerServer, token: string): WebSocket {
  return track(new WebSocket(serverUrl(server), WORKER_CHANNEL_SUBPROTOCOL, {
    headers: { authorization: `Bearer ${token}` },
  }));
}

async function openSocket(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

async function nextFrame(socket: WebSocket): Promise<ReturnType<typeof decodeFrame>> {
  const state = inboxes.get(socket);
  if (!state) throw new Error("socket was not tracked; use connect()");
  const buffered = state.data.shift();
  const data = buffered ?? await new Promise<Buffer>((resolve, reject) => {
    state.waiters.push(resolve);
    socket.once("error", reject);
  });
  return decodeFrame(data);
}

async function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve(1000);
    socket.once("close", (code) => resolve(code));
  });
}

function accept(epoch: number, cursor = 0, graceMs = 60_000): AcceptFrame {
  const payload: ChannelAccept = {
    protocol: WORKER_CHANNEL_PROTOCOL,
    controllerEpoch: epoch,
    leaseId: `lease-${epoch}`,
    lastAcceptedWorkerSeq: cursor,
    heartbeatMs: 10_000,
    disconnectGraceMs: graceMs,
    maxInFlightBytes: 8 * 1024 * 1024,
  };
  return { v: 1, type: "channel.accept", seq: 0, payload };
}

function envelope(instanceId: string, epoch: number, seq: number, payload: unknown): WorkerCommand {
  return {
    v: 1,
    type: "run.start",
    id: randomUUID(),
    runId: 71,
    instanceId,
    controllerEpoch: epoch,
    seq,
    sentAt: "2026-07-15T00:00:00.000Z",
    payload,
  } as WorkerCommand;
}

const startPayload = {
  mode: "start",
  run: { id: 71 },
  task: null,
  plan: null,
  persona: { id: "implementor" },
  repository: { id: "repo" },
  transcript: [],
  inboxDigest: null,
  memoryContext: "",
  pendingInput: [],
  policy: { allowedTools: [], maxTurns: null, deadline: null },
};

/** A minimal injected session that isolates the supervisor's transport duties
 * from the real session's epoch/replay ownership. */
function fakeSession(overrides: Partial<WorkerSessionLike> = {}): WorkerSessionLike {
  return {
    attach: vi.fn(async () => {}),
    receive: vi.fn(async () => {}),
    emit: vi.fn(async () => ({}) as never),
    handshakeState: () => ({ lastControllerEpoch: 0, lastAckedControlSeq: 0, nextWorkerSeq: 1 }),
    abort: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("worker WebSocket supervisor", () => {
  it("serves only the exact authenticated upgrade endpoint", async () => {
    const { server, token } = await makeServer();
    const ordinary = await fetch(serverUrl(server).replace("ws://", "http://"));
    expect(ordinary.status).toBe(404);
    expect(await ordinary.text()).toBe("");

    const wrongPath = new WebSocket(serverUrl(server).replace("/worker/channel", "/worker/channel/"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await new Promise<number>((resolve) => wrongPath.once("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0)))).toBe(404);

    const wrongAuth = new WebSocket(serverUrl(server), WORKER_CHANNEL_SUBPROTOCOL, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(await new Promise<number>((resolve) => wrongAuth.once("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0)))).toBe(401);

    const socket = connect(server, token);
    await openSocket(socket);
    expect((await nextFrame(socket)).type).toBe("channel.hello");
    socket.close();
  });

  it("binds TCP from the `tcp:host:port` listen form dockerListenEndpoint emits", async () => {
    // Regression: parseEndpoint only recognized the `tcp://` URL form, so the
    // colon listen form (dockerListenEndpoint) fell through to the unix-socket
    // default and a Docker worker bound a socket under the
    // root-owned /app instead of TCP. The endpoint string must win over the
    // transport/host/port fields, so pass ONLY it.
    const root = await mkdtemp(join(tmpdir(), "worker-channel-server-"));
    roots.push(root);
    const runId = 71;
    const instanceId = `wi_${"a".repeat(32)}`;
    const token = mintChannelCredential(runId, instanceId, { secret });
    const server = await startWorkerServer({
      runId,
      instanceId,
      credential: token,
      credentialSecret: secret,
      outboxRoot: root,
      endpoint: "tcp:127.0.0.1:0",
    });
    servers.push(server);
    const address = server.address();
    expect(address && typeof address === "object").toBe(true);

    const socket = connect(server, token);
    await openSocket(socket);
    expect((await nextFrame(socket)).type).toBe("channel.hello");
    socket.close();
  });

  it("forwards controller frames to the session and streams session output to the socket", async () => {
    const { server, token, instanceId } = await makeServer();
    const socket = connect(server, token);
    await openSocket(socket);
    expect((await nextFrame(socket)).type).toBe("channel.hello");
    socket.send(encodeFrame(accept(1)));

    socket.send(encodeFrame(envelope(instanceId, 1, 1, startPayload)));
    // The session (not the supervisor) assigns the ack and start resolution.
    expect((await nextFrame(socket)).type).toBe("channel.ack");
    await expect(server.session.waitForStart!()).resolves.toMatchObject({ mode: "start" });

    const event = await server.emit("agent.event", { event: { kind: "checkpoint" } });
    expect(event.seq).toBe(1);
    expect((await nextFrame(socket)).type).toBe("agent.event");
    socket.close();
  });

  it("admits one controller and fences a superseded or stale competitor", async () => {
    const { server, token, instanceId } = await makeServer();
    const first = connect(server, token);
    await openSocket(first);
    await nextFrame(first);
    first.send(encodeFrame(accept(1)));

    const second = connect(server, token);
    await openSocket(second);
    await nextFrame(second);
    second.send(encodeFrame(accept(2)));
    expect(await closed(first)).toBe(4409);

    const stale = connect(server, token);
    await openSocket(stale);
    await nextFrame(stale);
    stale.send(encodeFrame(accept(1)));
    expect((await nextFrame(stale)).type).toBe("channel.reject");
    expect(await closed(stale)).toBe(4409);
    void instanceId;
    second.close();
  });

  it("holds the session through disconnect grace and aborts after expiry", async () => {
    const abort = vi.fn();
    const session = fakeSession({ abort, close: vi.fn(async () => {}) });
    const { server, token } = await makeServer({ session, disconnectGraceMs: 40 });
    const socket = connect(server, token);
    await openSocket(socket);
    await nextFrame(socket);
    socket.send(encodeFrame(accept(1, 0, 40)));
    // Let the accept land so the session becomes the active controller.
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.close();
    await closed(socket);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(abort).toHaveBeenCalledWith("worker controller disconnect grace expired");
    void server;
  });

  it("times out handshakes and uses the protocol frame limit", async () => {
    const { server, token } = await makeServer({ acceptTimeoutMs: 35 });
    const socket = connect(server, token);
    await openSocket(socket);
    await nextFrame(socket);
    expect(await closed(socket)).toBe(4408);

    const limited = await makeServer();
    const oversized = connect(limited.server, limited.token);
    await openSocket(oversized);
    await nextFrame(oversized);
    oversized.send(JSON.stringify({ text: "x".repeat(1_048_576) }));
    expect(await closed(oversized)).toBe(4413);
  });

  it("drains with a clean close", async () => {
    const { server, token } = await makeServer();
    const socket = connect(server, token);
    await openSocket(socket);
    await nextFrame(socket);
    socket.send(encodeFrame(accept(1)));
    await server.drain("test drain");
    expect(await closed(socket)).toBe(1000);
  });
});
