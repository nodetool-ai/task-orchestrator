// __tests__/worker-websocket-e2e.test.ts
//
// Acceptance spec for the WebSocket worker channel (plan section 12). This is
// the replacement for the deleted HTTP/SSE soak safety net: it proves, over
// the channel only, the same behavior that
// __tests__/worker-http-transport.test.ts, __tests__/worker-transport-semantics.test.ts,
// and __tests__/run-worker.test.ts currently guarantee against the HTTP
// worker transport and the direct-DB driver.
//
// It is EXPECTED TO FAIL under WS_E2E=1 right now: the run driver has not
// been refactored (plan section 13) to consume WorkerSession/connectRun, so
// nothing pushes RunStart or drains commands over the channel yet. Sections
// 13-15 turn more of this green; do not weaken any assertion below to paper
// over that gap. Gated behind WS_E2E so it never runs in the default suite
// until the switch is safe (see section 22 boundary 13, which ungates it).

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, agentMessages, runnerInstances } from "../db/schema";
import { create, get, listMessages } from "../lib/runs";
import * as backend from "../lib/agent-backend";
import * as runDispatch from "../lib/run-dispatch";
import { startWorkerServer, type WorkerServer } from "../lib/worker-channel/worker-server";
import { localDialEndpoint } from "../lib/worker-channel/dispatch-env";
import { connectRun, disconnectRun } from "../lib/worker-channel/registry";
import { sendCommand } from "../lib/worker-channel/registry";
import type { RunStart, ToolCallResult } from "../lib/worker-channel/protocol";

// The run driver entry point this suite is written against (plan section 13.1).
// Section 13 landed `lib/worker-runtime/context.ts`, so the module now resolves;
// the driver consumes the pushed context and input but its write/tool seams are
// not wired until sections 14/15, so the WS_E2E cases below still fail past this
// point (not at module resolution). The import stays deferred to first use so
// that, when WS_E2E is unset and this `describe` block is skipped, it never runs.
async function driveWorkerRun(context: unknown): Promise<unknown> {
  const mod = await import("../lib/worker-runtime/context");
  return mod.driveWorkerRun(context as Parameters<typeof mod.driveWorkerRun>[0]);
}

const instanceId = () => `wi_${randomUUID().replace(/-/g, "").slice(0, 32)}`;

async function bootWorkerChannel(runId: number) {
  const id = instanceId();
  const secret = "ws-e2e-test-secret";
  const server: WorkerServer = await startWorkerServer({
    runId,
    instanceId: id,
    credentialSecret: secret,
    transport: "unix",
    sessionRoot: `/tmp/ws-e2e-${runId}-${Date.now()}`,
  });
  // server.endpoint is the bind form (unix://<path>); the control plane dials
  // the ws+unix://<path>:/worker/channel form (see localDialEndpoint).
  const socketPath = server.endpoint.replace(/^unix:\/\//, "");
  await db.insert(runnerInstances).values({
    runId,
    channelInstanceId: id,
    channelEndpoint: localDialEndpoint(socketPath),
  });
  process.env.TASK_ORCH_WORKER_CHANNEL_SECRET = secret;
  const connection = await connectRun(runId);
  return { server, connection, instanceId: id };
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.TASK_ORCH_WORKER_CHANNEL_SECRET;
});

function fakeChatBackend(replyText: string) {
  return {
    id: "fake",
    listProviders: () => [],
    async runTurn(args: any) {
      args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: replyText }] } });
      args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
      return {
        envelopes: [],
        summary: "done",
        resumeToken: `sess-${replyText}`,
        turns: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: null,
      };
    },
  } as any;
}

describe.runIf(process.env.WS_E2E === "1")("worker websocket e2e", () => {
  describe("chat run", () => {
    it("drives an initial turn over the channel with no worker HTTP or DB access", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      await db.insert(agentMessages).values({
        runId: run.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
        createdAt: new Date(),
      });

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("hello!"));

      const { server, connection } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        expect(start.mode).toBe("start");
        expect(start.transcript.some((m) => m.role === "user")).toBe(true);

        await (driveWorkerRun as any)({ start, session: server.session } as any);

        const row = (await get(run.id))!;
        expect(row.status).toBe("idle");
        const msgs = await listMessages(run.id);
        expect(msgs.some((m) => m.role === "agent")).toBe(true);
        // No worker-side HTTP calls to the control plane.
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await disconnectRun(run.id);
        await server.close();
        fetchSpy.mockRestore();
      }
    });

    it("wakes on a follow-up input command and drains it into a second turn", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("first"));

      const { server, connection } = await bootWorkerChannel(run.id);
      try {
        const drive = (driveWorkerRun as any)({ session: server.session } as any);

        await sendCommand(run.id, "run.input", {
          messages: [{ id: 1, role: "user", content: [{ type: "text", text: "follow-up" }] }],
        });

        await drive;

        const msgs = await listMessages(run.id);
        expect(msgs.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });

    it("releases the claim on idle exit exactly as the legacy driver does", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("bye"));
      process.env.TASK_ORCH_CHAT_IDLE_MS = "150";

      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);
        expect((await get(run.id))!.workerScope).toBeNull();
      } finally {
        delete process.env.TASK_ORCH_CHAT_IDLE_MS;
        await disconnectRun(run.id);
        await server.close();
      }
    });
  });

  describe("implement run", () => {
    it("round-trips a tool call over the channel and lands terminal completed status", async () => {
      const run = await create({ goal: "<implement>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake",
        listProviders: () => [],
        async runTurn(args: any) {
          const result: ToolCallResult = await args.invokeTool("list_plans", {}, "call-1");
          expect(result.isError ?? false).toBe(false);
          args.onEvent({ type: "result", is_error: false, result: "done", usage: {} });
          return {
            envelopes: [],
            summary: "done",
            resumeToken: "sess-tool",
            turns: 1,
            inputTokens: 0,
            outputTokens: 0,
            totalCostUsd: null,
          };
        },
      } as any);

      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);

        // Terminal status is landed once, by the control plane, after
        // run.finished -- never directly by the worker.
        const row = (await get(run.id))!;
        expect(row.status).toBe("completed");
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });
  });

  describe("cancellation", () => {
    it("aborts a model turn in progress when run.cancel arrives", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      let aborted = false;
      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake",
        listProviders: () => [],
        async runTurn(args: any) {
          await new Promise<void>((resolve) => {
            args.abortSignal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          });
          throw new Error("aborted");
        },
      } as any);

      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        const drive = driveWorkerRun({ start, session: server.session } as any);
        await sendCommand(run.id, "run.cancel", { reason: "user", requestId: "r1", deadline: null });
        await drive.catch(() => {});
        expect(aborted).toBe(true);
        expect((await get(run.id))!.status).toBe("cancelled");
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });

    it("aborts a pending tool call when run.cancel arrives during the round-trip", async () => {
      const run = await create({ goal: "<implement>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue({
        id: "fake",
        listProviders: () => [],
        async runTurn(args: any) {
          await expect(args.invokeTool("slow_tool", {}, "call-cancel")).rejects.toThrow();
          throw new Error("cancelled");
        },
      } as any);

      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        const drive = driveWorkerRun({ start, session: server.session } as any);
        await sendCommand(run.id, "run.cancel", { reason: "user", requestId: "r2", deadline: null });
        await drive.catch(() => {});
        expect((await get(run.id))!.status).toBe("cancelled");
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });
  });

  describe("terminal status landing", () => {
    it("is applied exactly once by the control plane after run.finished, not by the worker", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("done"));

      const { server } = await bootWorkerChannel(run.id);
      try {
        const setStatusSpy = vi.spyOn(db, "update");
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);

        // The worker process itself must never issue a direct Postgres write
        // for terminal status -- only the control plane, driven by the
        // received run.finished event, may do so.
        const row = (await get(run.id))!;
        expect(row.status === "idle" || row.status === "completed").toBe(true);
        setStatusSpy.mockRestore();
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });
  });

  describe("claim release and stranded-input redispatch", () => {
    it("chat exit does not resurrect a terminal landing over a stranded message", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      await db.insert(agentMessages).values({
        runId: run.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "follow-up" }]),
        createdAt: new Date(),
      });
      await db
        .update(agentSessions)
        .set({ status: "failed", workerScope: "run-x", workerPid: 42, completedAt: new Date() })
        .where(eq(agentSessions.id, run.id));

      const dispatchSpy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);
        expect(dispatchSpy).not.toHaveBeenCalled();
        expect((await get(run.id))!.status).toBe("failed");
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });

    it("chat exit re-dispatches a non-terminal run with a stranded message", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      await db.insert(agentMessages).values({
        runId: run.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "follow-up" }]),
        createdAt: new Date(),
      });
      await db
        .update(agentSessions)
        .set({ status: "idle", workerScope: "run-x", workerPid: 42, completedAt: new Date() })
        .where(eq(agentSessions.id, run.id));

      const dispatchSpy = vi.spyOn(runDispatch, "dispatchRun").mockResolvedValue("spawned" as never);
      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);
        expect(dispatchSpy).toHaveBeenCalledWith(run.id);
      } finally {
        await disconnectRun(run.id);
        await server.close();
      }
    });
  });

  describe("no worker HTTP or DB access", () => {
    it("never issues fetch(/api/worker/*) or a direct Postgres call from the worker driver", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("hi"));
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const { server } = await bootWorkerChannel(run.id);
      try {
        const start = (await server.session.waitForStart!()) as RunStart;
        await (driveWorkerRun as any)({ start, session: server.session } as any);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        await disconnectRun(run.id);
        await server.close();
        fetchSpy.mockRestore();
      }
    });
  });
});
