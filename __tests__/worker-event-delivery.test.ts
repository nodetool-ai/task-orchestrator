import { describe, expect, it, vi, afterEach } from "vitest";
import * as backend from "../lib/agent-backend";
import { buildWorkerRunContext, driveWorkerRun, type WorkerDriverSession } from "../lib/worker-runtime/context";
import type { MessageSnapshot, RunStart } from "../lib/worker-channel/protocol";

function start(overrides: Partial<RunStart> = {}): RunStart {
  return {
    mode: "start", run: { id: 810, status: "idle", goal: "<chat>" }, task: null, plan: null,
    persona: { id: "implementor" }, repository: { id: "none" },
    transcript: [{ id: 1, role: "agent", content: [{ type: "text", text: "previous" }] }],
    inboxDigest: null, memoryContext: "", pendingInput: [], policy: { allowedTools: [], maxTurns: null, deadline: null },
    ...overrides,
  };
}

function session(commands: any[] = []): { value: WorkerDriverSession; emitted: any[] } {
  const emitted: any[] = [];
  const value: WorkerDriverSession = {
    async *commands() { for (const command of commands) yield command; },
    async emit(type, payload) { emitted.push({ type, payload }); return { id: `e${emitted.length}` }; },
    abortSignal: new AbortController().signal,
  };
  return { value, emitted };
}

describe("worker durable event delivery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts the bootstrap digest and typed event in the backend prompt", async () => {
    const prompts: string[] = [];
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        prompts.push(args.prompt);
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ack" }] } });
        return { envelopes: [], summary: "ack", resumeToken: "next", turns: 1 };
      },
    } as any);
    const event: MessageSnapshot = { id: 2, role: "system", content: [{
      type: "run_event", schema_version: 1, event_id: 4812, delivery_id: 812,
      event_type: "run.attempt_finished", source: { run_id: 42, attempt: 3, revision: 17 }, payload: { status: "completed" },
    }] };
    const { value, emitted } = session();
    await driveWorkerRun({ start: start({ inboxDigest: "legacy event digest", transcript: [start().transcript[0], event] }), session: value });
    expect(prompts[0]).toContain("legacy event digest");
    expect(prompts[0]).toContain("Quoted run event from run 42, attempt 3, revision 17, event_id 4812, delivery_id 812: run.attempt_finished");
    expect(prompts[0]).toContain('"event_id":4812');
    expect(emitted.some((entry) => entry.type === "transcript.append")).toBe(true);
  });

  it("does not treat transcript rows as input receipts", () => {
    const s = start();
    const context = buildWorkerRunContext(s, session().value);
    // A replayed transcript message has no durable input identity and can be
    // offered again; only the explicit manifest seeds dedupe.
    expect(context.pendingInput).toEqual([]);
  });

  it("runs assigned manifests serially, advances resume state, then parks before PR sync", async () => {
    const prompts: string[] = [];
    const checkpoints: any[] = [];
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        prompts.push(args.prompt);
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "step" }] } });
        return { envelopes: [], summary: "step", resumeToken: `resume-${prompts.length}`, turns: 1 };
      },
    } as any);
    const input = {
      messages: [{ id: 3, role: "system", content: [{ type: "run_event", event_type: "run.turn_finished", source: { id: 7 }, payload: { ok: true } }] }],
      inputIds: ["input-2"], inputSeqs: [2], turnId: "turn-2",
    };
    const commands = [input, { reason: "waiting for child", }];
    const { value, emitted } = session(commands);
    await driveWorkerRun({ start: start({
      run: { id: 811, status: "running", goal: "<implement>", branch: "no-branch" },
      transcript: [], pendingInput: [{ id: 1, role: "user", content: [{ type: "text", text: "begin" }] }],
      turnId: "turn-1", inputManifest: [{ id: "input-1", inputSeq: 1, messageId: 1, kind: "user" }],
    }), session: value });
    checkpoints.push(...emitted.filter((entry) => entry.type === "run.checkpoint"));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("begin");
    expect(checkpoints.map((entry) => entry.payload.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(checkpoints.map((entry) => entry.payload.inputIds)).toEqual([["input-1"], ["input-2"]]);
    expect(checkpoints[1].payload.sdkSessionId).toBe("resume-2");
    expect(emitted.some((entry) => entry.type === "run.finished")).toBe(false);
    expect(emitted.some((entry) => entry.type === "run.phase" && entry.payload.phase === "parked")).toBe(true);
  });

  it("rehydrates canonical event history when an SDK resume token is missing", async () => {
    let prompt = "";
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        prompt = args.prompt;
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
        return { envelopes: [], summary: "ok", resumeToken: "restored", turns: 1 };
      },
    } as any);
    const event: MessageSnapshot = { id: 4, role: "system", content: [{
      type: "run_event", event_type: "run.attempt_finished", source: { id: 99 }, payload: { status: "failed" },
    }] };
    const { value } = session();
    await driveWorkerRun({ start: start({ mode: "resume", run: { id: 812, status: "idle", goal: "<chat>" }, transcript: [event] }), session: value });
    expect(prompt).toContain("Durable conversation recovery");
    expect(prompt).toContain("Quoted run event from run 99, event_id unknown, delivery_id unknown: run.attempt_finished");
  });

  it("batches multiple initial chat manifest messages into one invocation and receipt", async () => {
    let calls = 0;
    const checkpoints: any[] = [];
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        calls += 1;
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "combined" }] } });
        return { envelopes: [], summary: "combined", resumeToken: "combined-token", turns: 1 };
      },
    } as any);
    const first: MessageSnapshot = { id: 11, role: "system", content: [{ type: "run_event", event_type: "run.question_opened", source: { id: 4 }, payload: { question: "a" } }] };
    const second: MessageSnapshot = { id: 12, role: "system", content: [{ type: "run_event", event_type: "run.question_opened", source: { id: 4 }, payload: { question: "b" } }] };
    const { value, emitted } = session([{ reason: "turn_finished", action: "idle" }]);
    await driveWorkerRun({ start: start({
      run: { id: 813, status: "idle", goal: "<chat>" }, transcript: [], pendingInput: [first, second],
      turnId: "chat-turn", inputManifest: [
        { id: "chat-input-a", inputSeq: 1, messageId: 11, kind: "event" },
        { id: "chat-input-b", inputSeq: 2, messageId: 12, kind: "event" },
      ],
    }), session: value });
    checkpoints.push(...emitted.filter((entry) => entry.type === "run.checkpoint"));
    expect(calls).toBe(1);
    expect(checkpoints[0].payload.turnId).toBe("chat-turn");
    expect(checkpoints[0].payload.inputIds).toEqual(["chat-input-a", "chat-input-b"]);
    expect(checkpoints[0].payload.sdkSessionId).toBe("combined-token");
  });

  it("accepts an explicit finalize decision after a durable checkpoint", async () => {
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
        return { envelopes: [], summary: "done", resumeToken: "final-token", turns: 1 };
      },
    } as any);
    const { value, emitted } = session([{ reason: "ready", action: "finalize" }]);
    await driveWorkerRun({ start: start({
      run: { id: 814, status: "running", goal: "<execute>" }, turnId: "final-turn",
      inputManifest: [{ id: "final-input", inputSeq: 1, messageId: 1, kind: "user" }],
      transcript: [], pendingInput: [{ id: 1, role: "user", content: [{ type: "text", text: "finish" }] }],
    }), session: value });
    expect(emitted.some((entry) => entry.type === "run.finished")).toBe(true);
  });

  it("uses the latest assigned turn summary and usage for terminal finalization", async () => {
    const prompts: string[] = [];
    vi.spyOn(backend, "getBackend").mockResolvedValue({
      id: "fake", listProviders: () => [],
      async runTurn(args: any) {
        prompts.push(args.prompt);
        await args.onEvent({ type: "assistant", message: { content: [{ type: "text", text: `reply-${prompts.length}` }] } });
        await args.onEvent({ type: "result", is_error: false, result: `summary-${prompts.length}`, usage: {
          input_tokens: prompts.length * 10, output_tokens: prompts.length * 20,
        } });
        return { envelopes: [], summary: `summary-${prompts.length}`, resumeToken: `resume-${prompts.length}`, turns: 1 };
      },
    } as any);
    const followUp = {
      messages: [{ id: 2, role: "user", content: [{ type: "text", text: "second" }] }],
      inputIds: ["input-2"], inputSeqs: [2], turnId: "turn-2",
    };
    const { value, emitted } = session([followUp, { reason: "ready", action: "finalize" }]);
    await driveWorkerRun({ start: start({
      run: { id: 815, status: "running", goal: "<execute>" }, transcript: [],
      pendingInput: [{ id: 1, role: "user", content: [{ type: "text", text: "first" }] }],
      turnId: "turn-1", inputManifest: [{ id: "input-1", inputSeq: 1, messageId: 1, kind: "user" }],
    }), session: value });
    const finished = emitted.find((entry) => entry.type === "run.finished");
    expect(prompts).toHaveLength(2);
    expect(finished?.payload).toMatchObject({
      result: "summary-2", usage: { inputTokens: 20, outputTokens: 40 },
    });
  });
});
