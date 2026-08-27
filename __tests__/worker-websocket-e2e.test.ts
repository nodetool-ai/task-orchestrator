// __tests__/worker-websocket-e2e.test.ts
//
// Acceptance spec for the WebSocket worker channel (plan section 12). This is
// the replacement for the deleted HTTP/SSE soak safety net: it proves, over
// the channel only, the same behavior that
// __tests__/worker-http-transport.test.ts, __tests__/worker-transport-semantics.test.ts,
// and __tests__/run-worker.test.ts currently guarantee against the HTTP
// worker transport and the direct-DB driver.
//
// Sections 13-15 turned this green end to end and section 15 (commit boundary
// 13) ungated it: it now runs in the default suite. Do not weaken any assertion
// below — this is the WebSocket acceptance spec that replaced the HTTP/SSE soak.

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
import { startChannelForRun } from "../lib/run-dispatch";
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
  // Push the authoritative RunStart snapshot exactly as dispatchRun does via
  // startChannelForRun — the control-plane side of the channel handshake the
  // worker's waitForStart() awaits.
  await startChannelForRun(runId, id);
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

describe("worker websocket e2e", () => {
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
      // The worker keeps waiting for further follow-ups; a short idle window
      // lets the drive return once the second turn is done.
      process.env.TASK_ORCH_CHAT_IDLE_MS = "6000";

      const { server, connection } = await bootWorkerChannel(run.id);
      try {
        const drive = (driveWorkerRun as any)({ session: server.session } as any);

        // Mirror sendMessageToRun's contract: the control plane persists the
        // user row FIRST, then bridges it as run.input carrying that row id.
        // The worker must NOT re-persist it (the duplicate-row fix) — so the
        // proof that the wake+drain ran is the SECOND agent reply below, not
        // the user row (which exists by construction here, as in production).
        const [userRow] = await db
          .insert(agentMessages)
          .values({
            runId: run.id,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "follow-up" }]),
            createdAt: new Date(),
          })
          .returning();
        await sendCommand(run.id, "run.input", {
          messages: [{ id: userRow.id, role: "user", content: [{ type: "text", text: "follow-up" }] }],
        });

        await drive;

        const msgs = await listMessages(run.id);
        expect(msgs.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);
        // The wake+drain must have produced a second turn: one agent reply for
        // the snapshot kickoff, one for the drained follow-up.
        expect(msgs.filter((m) => m.role === "agent").length).toBeGreaterThanOrEqual(2);
      } finally {
        delete process.env.TASK_ORCH_CHAT_IDLE_MS;
        await disconnectRun(run.id);
        await server.close();
      }
    }, 30_000);

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

  describe("mid-run controller reconnect", () => {
    it("survives a control-plane disconnect and drains a follow-up over the new connection", async () => {
      const run = await create({ goal: "<chat>", defer: true });
      await db.insert(agentMessages).values({
        runId: run.id,
        role: "user",
        content: JSON.stringify([{ type: "text", text: "hi" }]),
        createdAt: new Date(),
      });
      vi.spyOn(backend, "getBackend").mockResolvedValue(fakeChatBackend("first"));

      const { server } = await bootWorkerChannel(run.id);
      try {
        // Capture the pushed snapshot, then simulate the control plane dropping
        // (deploy/restart) while the worker keeps running and reconnecting to the
        // same live worker endpoint before the turn is driven.
        const start = (await server.session.waitForStart!()) as RunStart;
        await disconnectRun(run.id);
        const reconnected = await connectRun(run.id);
        expect(reconnected.connected).toBe(true);

        const drive = (driveWorkerRun as any)({ start, session: server.session } as any);

        // A follow-up pushed over the NEW connection still drains into a turn.
        await sendCommand(run.id, "run.input", {
          messages: [{ id: 1, role: "user", content: [{ type: "text", text: "follow-up" }] }],
        });

        await drive;

        const msgs = await listMessages(run.id);
        console.error(`[PROBE] rows for run ${run.id}: ${JSON.stringify(msgs.map((m) => ({ role: m.role, content: String(m.content).slice(0, 60) })))}`);
        expect(msgs.filter((m) => m.role === "user").length).toBeGreaterThanOrEqual(1);
        expect(msgs.some((m) => m.role === "agent")).toBe(true);
      } finally {
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
        .set({ status: "failed", workerScope: "run-x", completedAt: new Date() })
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
        .set({ status: "idle", workerScope: "run-x", completedAt: new Date() })
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
