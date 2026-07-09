// __tests__/extensions/spawn-remote.test.ts
//
// Behavioural tests for spawn__append_message's worker-routing:
//
//   BUG M3 — in remote-runner mode, append_message must route the child's turn
//     through runs.sendMessageToRun (persist + dispatch a worker, relay the
//     stream) instead of driving runs.append DIRECTLY inside the caller's
//     container. It must persist+dispatch and DETACH (close the relay iterator)
//     rather than float the tail past the tool return.
//
//   R7b — append_message is always non-blocking: it returns {status:"running"}
//     immediately and never holds the turn (or the server-side HTTP connection)
//     open waiting on the child. Waiting is await_session's park/event job. The
//     `await`/`timeout_seconds` blocking params are gone from the tool surface.
//
//   Plus: lastAgentText reports the LATEST agent text (ORDER BY id).
//
// These exercise the registered tool's execute() with runs.* / runDispatch.*
// spied per the repo's vi.spyOn pattern; the DB is the fork's throwaway Postgres.

import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { agentSessions, agentMessages } from "../../db/schema";
import { seedPersonas } from "../../db/seed-personas";
import { spawnExtension } from "../../lib/extensions/spawn";
import type { AppendStreamEvent } from "../../lib/runs";
import * as runs from "../../lib/runs";
import * as runDispatch from "../../lib/run-dispatch";

type ToolDef = {
  name: string;
  execute: (id: string, args: any) => Promise<any>;
};

function registerTools(runId: number, _runRow?: any): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const reg: any = { registerTool: (def: ToolDef) => tools.set(def.name, def), on: () => {} };
  spawnExtension({ runId })(reg);
  return tools;
}

// A caller run row with no budget cap and no parent (so tree-budget / depth /
// ancestor guards all pass without needing DB rows for the caller itself).
const CALLER_ROW = {
  id: 900001,
  parentRunId: null,
  budgetMaxUsd: null,
  repoId: null,
  userId: null,
} as any;

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(agentSessions);
});

describe("append_message → remote-runner routing (BUG M3)", () => {
  it("routes through sendMessageToRun, persists+dispatches, then detaches", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    // Target run is idle/appendable.
    vi.spyOn(runs, "get").mockImplementation(async (id: number) =>
      id === CALLER_ROW.id
        ? CALLER_ROW
        : ({ status: "idle", cwdStrategy: "none", totalCostUsd: null } as any)
    );
    const appendSpy = vi.spyOn(runs, "append");

    // Fake worker relay: yields the just-persisted user_message frame (which, per
    // sendMessageToRun's contract, proves persist+dispatch already ran) and then
    // waits on the relay's abort. `finallyRan` records that the iterator was
    // closed (relayRunStream's finally / unsub) — i.e. NOT leaked.
    let finallyRan = false;
    let sawAbort: AbortController | null = null;
    async function* relayGen(opts: { abort: AbortController }): AsyncGenerator<AppendStreamEvent> {
      sawAbort = opts.abort;
      try {
        yield { type: "user_message", message: {} as any };
        await new Promise<void>((res) => {
          if (opts.abort.signal.aborted) return res();
          opts.abort.signal.addEventListener("abort", () => res(), { once: true });
        });
      } finally {
        finallyRan = true;
      }
    }
    const sendSpy = vi
      .spyOn(runs, "sendMessageToRun")
      .mockImplementation((opts: any) => relayGen(opts));

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "hello child",
    });

    // Routed through the worker model, NOT the in-process append.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ runId: 42, role: "user", text: "hello child" });
    expect(sendSpy.mock.calls[0][0].abort).toBeInstanceOf(AbortController);
    expect(appendSpy).not.toHaveBeenCalled();

    // Detached: the relay iterator was closed (finally ran) and its controller aborted.
    expect(finallyRan).toBe(true);
    expect(sawAbort!.signal.aborted).toBe(true);

    const body = parse(res);
    expect(body).toMatchObject({ run_id: 42, status: "running", awaited: false });
  });

  it("surfaces an up-front error frame from sendMessageToRun", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(runs, "get").mockImplementation(async (id: number) =>
      id === CALLER_ROW.id ? CALLER_ROW : ({ status: "idle", cwdStrategy: "none" } as any)
    );
    // eslint-disable-next-line require-yield
    async function* errGen(): AsyncGenerator<AppendStreamEvent> {
      yield { type: "error", error: "run vanished" };
    }
    vi.spyOn(runs, "sendMessageToRun").mockImplementation(() => errGen());

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "hi",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/run vanished/);
  });
});

describe("append_message → no blocking await param (R7b)", () => {
  it("does not expose await/timeout_seconds on the tool schema", () => {
    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const def: any = tools.get("spawn__append_message");
    const schema = def.parameters ?? def.def?.parameters;
    expect(schema?.properties?.await).toBeUndefined();
    expect(schema?.properties?.timeout_seconds).toBeUndefined();
    // Still takes the essentials.
    expect(schema?.properties?.run_id).toBeTruthy();
    expect(schema?.properties?.text).toBeTruthy();
  });

  it("returns immediately with status 'running' even while the child turn keeps streaming", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(runs, "get").mockImplementation(async (id: number) =>
      id === CALLER_ROW.id ? CALLER_ROW : ({ status: "idle", cwdStrategy: "none" } as any)
    );
    const appendSpy = vi.spyOn(runs, "append");

    let finallyRan = false;
    // A long-running child turn: it yields the first (persist+dispatch) frame,
    // then would keep streaming until the relay is aborted. append_message must
    // NOT wait for it — it detaches after the first frame and returns 'running'.
    async function* longGen(opts: { abort: AbortController }): AsyncGenerator<AppendStreamEvent> {
      try {
        yield { type: "user_message", message: {} as any };
        await new Promise<void>((res) => {
          if (opts.abort.signal.aborted) return res();
          opts.abort.signal.addEventListener("abort", () => res(), { once: true });
        });
      } finally {
        finallyRan = true;
      }
    }
    vi.spyOn(runs, "sendMessageToRun").mockImplementation((opts: any) => longGen(opts));

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const started = Date.now();
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "take your time",
    });
    // Returned promptly (detached), not after any multi-second/hour drain.
    expect(Date.now() - started).toBeLessThan(2000);
    const body = parse(res);
    expect(body).toMatchObject({ run_id: 42, status: "running", awaited: false });
    // Detached: relay iterator closed (finally ran), child NOT driven in-process.
    expect(finallyRan).toBe(true);
    expect(appendSpy).not.toHaveBeenCalled();
  });
});

describe("get_run → lastAgentText reports the LATEST agent text (ORDER BY id)", () => {
  it("returns the newest agent message's text, not an earlier one", async () => {
    await seedPersonas();
    const run = await runs.create({ goal: "<chat>", defer: true });

    // Insert an older agent answer, a user turn, then a newer agent answer.
    await db.insert(agentMessages).values({
      runId: run.id,
      role: "agent",
      content: JSON.stringify([{ type: "text", text: "old answer" }]),
      createdAt: new Date(),
    });
    await db.insert(agentMessages).values({
      runId: run.id,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "another question" }]),
      createdAt: new Date(),
    });
    await db.insert(agentMessages).values({
      runId: run.id,
      role: "agent",
      content: JSON.stringify([{ type: "text", text: "latest answer" }]),
      createdAt: new Date(),
    });

    const tools = registerTools(run.id, { ...CALLER_ROW, id: run.id } as any);
    const res = await tools.get("spawn__get_run")!.execute("c", { id: run.id });
    const body = parse(res);
    expect(body.last_text).toBe("latest answer");
  });
});
