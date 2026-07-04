// __tests__/extensions/spawn-remote.test.ts
//
// Behavioural tests for spawn__append_message's worker-routing + timeout fixes:
//
//   BUG M3 — in remote-runner mode, append_message must route the child's turn
//     through runs.sendMessageToRun (persist + dispatch a worker, relay the
//     stream) instead of driving runs.append DIRECTLY inside the caller's
//     container. await=false must persist+dispatch and DETACH (close the relay
//     iterator) rather than float the tail past the tool return.
//
//   BUG M2 — await=true is time-bounded: a wedged child returns status
//     'timed_out' with the child STILL running (not cancelled), and the relay
//     iterator is torn down (its finally runs) so it is not leaked.
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

function registerTools(runId: number, runRow: any): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const reg: any = { registerTool: (def: ToolDef) => tools.set(def.name, def), on: () => {} };
  spawnExtension({ runId, runRow })(reg);
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
  it("await=false routes through sendMessageToRun, persists+dispatches, then detaches", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    // Target run is idle/appendable.
    vi.spyOn(runs, "get").mockResolvedValue({
      status: "idle",
      cwdStrategy: "none",
      totalCostUsd: null,
    } as any);
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
      await: false,
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

  it("await=false surfaces an up-front error frame from sendMessageToRun", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(runs, "get").mockResolvedValue({ status: "idle", cwdStrategy: "none" } as any);
    // eslint-disable-next-line require-yield
    async function* errGen(): AsyncGenerator<AppendStreamEvent> {
      yield { type: "error", error: "run vanished" };
    }
    vi.spyOn(runs, "sendMessageToRun").mockImplementation(() => errGen());

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "hi",
      await: false,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/run vanished/);
  });

  it("await=true drains the relay to done and returns awaited result", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(runs, "get").mockResolvedValue({
      status: "idle",
      cwdStrategy: "none",
      totalCostUsd: 0.5,
    } as any);
    const appendSpy = vi.spyOn(runs, "append");
    async function* doneGen(): AsyncGenerator<AppendStreamEvent> {
      yield { type: "user_message", message: {} as any };
      yield { type: "sdk", sdk: {} as any };
      yield { type: "done" };
    }
    const sendSpy = vi.spyOn(runs, "sendMessageToRun").mockImplementation(() => doneGen());

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "finish up",
      await: true,
    });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    const body = parse(res);
    expect(body).toMatchObject({ run_id: 42, awaited: true, status: "idle" });
  });
});

describe("append_message → await=true timeout (BUG M2)", () => {
  it("returns 'timed_out' without cancelling the child, and tears down the relay", async () => {
    vi.spyOn(runDispatch, "remoteRunnerEnabled").mockReturnValue(true);
    vi.spyOn(runs, "get").mockResolvedValue({ status: "running", cwdStrategy: "worktree" } as any);
    const appendSpy = vi.spyOn(runs, "append");

    let finallyRan = false;
    // A wedged child turn: never yields a terminal frame; only ends when the
    // relay's abort fires (which our timeout path triggers to unsubscribe).
    async function* hangGen(opts: { abort: AbortController }): AsyncGenerator<AppendStreamEvent> {
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
    vi.spyOn(runs, "sendMessageToRun").mockImplementation((opts: any) => hangGen(opts));

    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const started = Date.now();
    const res = await tools.get("spawn__append_message")!.execute("c", {
      run_id: 42,
      text: "are you stuck?",
      await: true,
      timeout_seconds: 1, // minimum; keeps the test ~1s
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const body = parse(res);
    expect(body).toMatchObject({ run_id: 42, status: "timed_out", child_in_flight: true });
    expect(body.message).toMatch(/NOT cancelled/i);
    // The child was NOT driven in-process, and the relay iterator was closed
    // (finally ran) so the subscription is not leaked.
    expect(appendSpy).not.toHaveBeenCalled();
    expect(finallyRan).toBe(true);
  }, 10_000);

  it("accepts timeout_seconds within [1, 7200] on the schema", () => {
    const tools = registerTools(CALLER_ROW.id, CALLER_ROW);
    const def: any = tools.get("spawn__append_message");
    // TypeBox schema is exposed on the tool def's parameters.
    const schema = def.parameters ?? def.def?.parameters;
    // Locate the timeout_seconds property schema regardless of TypeBox internals.
    const prop = schema?.properties?.timeout_seconds;
    expect(prop).toBeTruthy();
    expect(prop.minimum).toBe(1);
    expect(prop.maximum).toBe(7200);
    expect(prop.default).toBe(1800);
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
