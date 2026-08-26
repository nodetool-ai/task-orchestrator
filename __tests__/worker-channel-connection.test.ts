import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import WebSocket from "ws";

import { ControllerConnection, ControllerProtocolError } from "../lib/worker-channel/connection";
import { mintChannelCredential } from "../lib/worker-channel/credential";
import { CLOSE_CODE_SCOPE_MISMATCH } from "../lib/worker-channel/protocol";

const INSTANCE_ID = "wi_0123456789abcdef0123456789abcdef";
const RUN_ID = 42;

describe("ControllerConnection sprites proxy", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of ["SPRITES_TOKEN", "TASK_ORCH_SPRITES_TOKEN", "TASK_ORCH_WORKER_CHANNEL_SECRET", "AUTH_SECRET"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
  });

  function saveEnv() {
    for (const k of ["SPRITES_TOKEN", "TASK_ORCH_SPRITES_TOKEN", "TASK_ORCH_WORKER_CHANNEL_SECRET", "AUTH_SECRET"]) {
      savedEnv[k] = process.env[k];
    }
  }

  it("dials the inner channel over the proxy tunnel with credential", async () => {
    saveEnv();
    process.env.SPRITES_TOKEN = "test-sprites-token";
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "test-secret";

    const credential = mintChannelCredential(RUN_ID, INSTANCE_ID);

    // Fake tunnel: PassThrough-based Duplex pair (just one PassThrough for the test)
    const fakeTunnel = new PassThrough();
    const openTunnel = vi.fn(async (target: { spriteName: string; port: number }) => {
      expect(target).toEqual({ spriteName: "to-run-1", port: 8787 });
      return fakeTunnel as unknown as import("node:stream").Duplex;
    });

    let recordedUrl: string | undefined;
    let recordedProtocols: string[] | undefined;
    let recordedOptions: WebSocket.ClientOptions | undefined;

    const fakeSocket = new PassThrough() as unknown as WebSocket;
    const createSocket = vi.fn((url: string, protocols: string[], options: WebSocket.ClientOptions) => {
      recordedUrl = url;
      recordedProtocols = protocols;
      recordedOptions = options;
      // Return a dummy WebSocket that won't be used further in this unit test
      return fakeSocket;
    });

    const conn = new ControllerConnection({
      runId: RUN_ID,
      instanceId: INSTANCE_ID,
      endpoint: "sprite://to-run-1:8787/worker/channel",
      controllerId: "test-controller",
      createSocket: createSocket as unknown as (endpoint: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket,
      openTunnel,
    });

    // Call private method directly
    const result = await (conn as unknown as { createSpritesProxiedSocket: (cred: string) => Promise<WebSocket> }).createSpritesProxiedSocket(credential);

    expect(result).toBe(fakeSocket);
    expect(openTunnel).toHaveBeenCalledTimes(1);
    expect(openTunnel).toHaveBeenCalledWith({ spriteName: "to-run-1", port: 8787 });

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(recordedUrl).toBe("ws://localhost:8787/worker/channel");
    expect(recordedProtocols).toEqual(["task-orchestrator.worker.v1"]);
    expect((recordedOptions?.headers as Record<string, string>)?.Authorization).toBe(`Bearer ${credential}`);

    // createConnection should return the tunnel Duplex
    const createConnection = (recordedOptions as unknown as { createConnection: () => import("node:net").Socket })?.createConnection;
    expect(typeof createConnection).toBe("function");
    expect(createConnection()).toBe(fakeTunnel as unknown as import("node:net").Socket);
  });

  it("throws protocol error when SPRITES_TOKEN is missing and never calls createSocket", async () => {
    saveEnv();
    delete process.env.SPRITES_TOKEN;
    delete process.env.TASK_ORCH_SPRITES_TOKEN;
    process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = "test-secret";

    const credential = mintChannelCredential(RUN_ID, INSTANCE_ID);
    const openTunnel = vi.fn(async () => new PassThrough() as unknown as import("node:stream").Duplex);
    const createSocket = vi.fn(() => new PassThrough() as unknown as WebSocket);

    const conn = new ControllerConnection({
      runId: RUN_ID,
      instanceId: INSTANCE_ID,
      endpoint: "sprite://to-run-1:8787/worker/channel",
      controllerId: "test-controller",
      createSocket: createSocket as unknown as (endpoint: string, protocols: string[], options: WebSocket.ClientOptions) => WebSocket,
      openTunnel,
    });

    let thrown: unknown;
    try {
      await (conn as unknown as { createSpritesProxiedSocket: (cred: string) => Promise<WebSocket> }).createSpritesProxiedSocket(credential);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ControllerProtocolError);
    expect((thrown as ControllerProtocolError).message).toBe("SPRITES_TOKEN is required to dial sprite:// endpoints");
    expect((thrown as ControllerProtocolError).closeCode).toBe(CLOSE_CODE_SCOPE_MISMATCH);
    expect((thrown as ControllerProtocolError).retryable).toBe(false);

    expect(openTunnel).not.toHaveBeenCalled();
    expect(createSocket).not.toHaveBeenCalled();
  });
});
