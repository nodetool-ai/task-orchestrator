// __tests__/worker-http-transport.test.ts
//
// The http RunTransport against a real loopback HTTP server wrapping
// handleWorkerApi — i.e. the actual wire: token auth, JSON bodies, date
// revival, the /control SSE channel (input wakeups + cancel push), and a full
// end-to-end chat turn driven by driveDispatchedRun with the process switched
// into HTTP worker mode (env-selected transport), exactly like an external
// worker with no DATABASE_URL of its own would run it.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions } from "../db/schema";
import * as backend from "../lib/agent-backend";
import { create, get, listMessages, driveDispatchedRun } from "../lib/runs";
import { handleWorkerApi } from "../lib/worker/api-handlers";
import { dbTransport } from "../lib/worker/db-transport";
import { createHttpTransport } from "../lib/worker/http-transport";
import { mintWorkerToken } from "../lib/worker/token";
import { __resetRunTransportForTests } from "../lib/worker";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.TASK_ORCH_WORKER_API_SECRET = "http-transport-test-secret";
  // Minimal Node adapter over handleWorkerApi — what Next's catch-all route
  // does in production.
  server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://127.0.0.1${req.url}`;
    const segments = new URL(url)
      .pathname.replace(/^\/api\/worker\//, "")
      .split("/")
      .map(decodeURIComponent);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
      signal: abort.signal,
    });
    try {
      const response = await handleWorkerApi(request, segments);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
    } catch {
      if (!res.headersSent) res.writeHead(500);
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.closeAllConnections?.();
  server.close();
  delete process.env.TASK_ORCH_WORKER_API_SECRET;
});

function transportFor(runId: number) {
  return createHttpTransport({ baseUrl, token: mintWorkerToken(runId) });
}

describe("http transport over the wire", () => {
  it("retries message appends with the same idempotency key after a timeout", async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn();
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          message: {
            id: 123,
            runId: 1,
            role: "agent",
            content: [{ type: "text", text: "ok" }],
            createdAt: new Date().toISOString(),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const t = createHttpTransport({
      baseUrl: "http://worker.test",
      token: "token",
      fetchImpl: fetchMock as any,
    });
    const msg = await t.appendMessage(1, "agent", [{ type: "text", text: "ok" }]);

    expect(msg.id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0].idempotencyKey).toMatch(/^msg:1:/);
    expect(bodies[1].idempotencyKey).toBe(bodies[0].idempotencyKey);
  });

  it("reads runs with dates revived and appends messages", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t = transportFor(run.id);

    const fetched = (await t.getRun(run.id))!;
    expect(fetched.id).toBe(run.id);
    expect(fetched.startedAt).toBeInstanceOf(Date);

    const msg = await t.appendMessage(run.id, "agent", [{ type: "text", text: "over the wire" }]);
    expect(msg.createdAt).toBeInstanceOf(Date);
    expect((await t.listMessages(run.id)).some((m) => m.id === msg.id)).toBe(true);
  });

  it("rejects a foreign run and surfaces the API error", async () => {
    const a = await create({ goal: "<chat>", defer: true });
    const b = await create({ goal: "<chat>", defer: true });
    const t = transportFor(a.id);
    await expect(t.getRun(b.id)).rejects.toMatchObject({ status: 403 });
  });

  it("lands guarded statuses idempotently and heartbeats the cancel flag", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const t = transportFor(run.id);

    expect(
      await t.applyStatus(run.id, "failed", {
        set: { error: "wire boom", completedAt: new Date() },
        guard: "not-terminal",
        extra: { error: "wire boom" },
        retries: 2,
      })
    ).toBe(true);
    expect(
      await t.applyStatus(run.id, "failed", { set: { error: "again" }, guard: "not-terminal" })
    ).toBe(false);
    expect((await get(run.id))!.error).toBe("wire boom");

    expect((await t.heartbeat(run.id)).cancelRequested).toBe(false);
    await db.update(agentSessions).set({ cancelRequested: 1 }).where(eq(agentSessions.id, run.id));
    expect((await t.heartbeat(run.id)).cancelRequested).toBe(true);
  });

  it("executes orchestrator tools server-side", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t = transportFor(run.id);
    const result = await t.callTool(run.id, "list_plans", {}, { author: "wire-test" });
    expect(result.isError ?? false).toBe(false);
  });

  it("pushes input wakeups over the /control SSE channel", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t = transportFor(run.id);

    let wake!: () => void;
    const woken = new Promise<void>((r) => (wake = r));
    const unsub = await t.subscribeInput(run.id, wake);
    try {
      // Give the SSE connection a beat to establish, then persist a user
      // message — the run_input trigger NOTIFYs, the server's control stream
      // forwards {type:"input"}.
      await new Promise((r) => setTimeout(r, 300));
      await dbTransport.appendMessage(run.id, "user", [{ type: "text", text: "wake up" }]);
      await expect(
        Promise.race([
          woken.then(() => "woken"),
          new Promise((r) => setTimeout(() => r("timeout"), 4000)),
        ])
      ).resolves.toBe("woken");
    } finally {
      unsub();
    }
  });

  it("pushes cancel over the /control SSE channel into the next heartbeat", async () => {
    const run = await create({ goal: "<chat>", defer: true });
    const t = transportFor(run.id);
    const unsub = await t.subscribeInput(run.id, () => {});
    try {
      await new Promise((r) => setTimeout(r, 300));
      await db.update(agentSessions).set({ cancelRequested: 1 }).where(eq(agentSessions.id, run.id));
      // Any run_stream event wakes the server-side cancel check; a status
      // mirror is exactly what cancel() writes in production.
      await dbTransport.appendEvent(run.id, "status", { status: "running" });
      // The latch arms asynchronously; poll the transport's heartbeat answer.
      let cancelSeen = false;
      for (let i = 0; i < 20 && !cancelSeen; i++) {
        await new Promise((r) => setTimeout(r, 200));
        cancelSeen = (await t.heartbeat(run.id)).cancelRequested;
      }
      expect(cancelSeen).toBe(true);
    } finally {
      unsub();
    }
  });
});

describe("end-to-end HTTP worker", () => {
  it("drives a chat turn with the env-selected http transport (no direct DB in the drive path)", async () => {
    // Create the run while still on the db transport (this is the server's job).
    const run = await create({ goal: "<chat>", defer: true });
    await dbTransport.appendMessage(run.id, "user", [{ type: "text", text: "hi over http" }]);

    process.env.TASK_ORCH_CHAT_IDLE_MS = "150";
    process.env.TASK_ORCH_LIGHTWEIGHT_CHATS = "0";
    process.env.TASK_ORCH_INSIDE_WORKER = "1";
    process.env.TASK_ORCH_WORKER_API_URL = baseUrl;
    process.env.TASK_ORCH_WORKER_TOKEN = mintWorkerToken(run.id);
    __resetRunTransportForTests();

    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake",
      listProviders: () => [],
      async runTurn(args: any) {
        args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "hello!" }] } });
        args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
        return {
          envelopes: [],
          summary: "done",
          resumeToken: "sess-http-1",
          turns: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalCostUsd: null,
        };
      },
    } as any);

    try {
      await driveDispatchedRun(run.id);
    } finally {
      vi.restoreAllMocks();
      delete process.env.TASK_ORCH_CHAT_IDLE_MS;
      delete process.env.TASK_ORCH_LIGHTWEIGHT_CHATS;
      delete process.env.TASK_ORCH_INSIDE_WORKER;
      delete process.env.TASK_ORCH_WORKER_API_URL;
      delete process.env.TASK_ORCH_WORKER_TOKEN;
      __resetRunTransportForTests();
    }

    const row = (await get(run.id))!;
    expect(row.status).toBe("idle");
    expect(row.workerScope).toBeNull();
    expect(row.sdkSessionId).toBe("sess-http-1");
    const msgs = await listMessages(run.id);
    expect(msgs.some((m) => m.role === "agent")).toBe(true);
    expect(msgs.filter((m) => m.role === "user").length).toBe(1);
  }, 20_000);
});
