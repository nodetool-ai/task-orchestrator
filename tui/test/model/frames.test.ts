import { describe, expect, it } from "vitest";
import type { MessageRow, SdkContentBlock } from "../../src/api/types.js";
import { appendFrame, frameFromEvent, framesFromMessages, spawnedIds, type Frame } from "../../src/model/frames.js";

const T0 = "2026-08-22T10:00:00.000Z";
let seq = 0;
function msg(role: MessageRow["role"], content: SdkContentBlock[], runId = 44): MessageRow {
  return { id: ++seq, runId, role, content, createdAt: T0 };
}

describe("framesFromMessages", () => {
  it("turns a realistic exchange into prose, one-line tools and a spawn", () => {
    const frames = framesFromMessages([
      msg("user", [{ type: "text", text: "ship the CLI plan" }]),
      msg("agent", [
        { type: "text", text: "Reading the plan." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "cli.ts" } },
      ]),
      msg("tool", [{ type: "tool_result", tool_use_id: "t1", content: "946 lines\nok" }]),
      msg("agent", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test -- cli" } }]),
      msg("tool", [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "42 passed" }] }]),
      msg("agent", [
        { type: "tool_use", id: "t3", name: "spawn__spawn_agent", input: { persona: "qa", goal: "verify" } },
      ]),
      msg("tool", [
        { type: "tool_result", tool_use_id: "t3", content: JSON.stringify({ run_id: 46, status: "pending" }) },
      ]),
      msg("agent", [{ type: "text", text: "   " }]), // blank turn: phantom gap
    ]);

    expect(frames.map((f) => f.kind)).toEqual(["user", "agent", "tool", "tool", "spawn"]);
    const tool = frames[2] as Extract<Frame, { kind: "tool" }>;
    // The default line stands alone without any detail.
    expect(tool.text).toBe("read cli.ts");
    // The transcript draws the same call as `Read(cli.ts)`; the result is the
    // `⎿` block under it, and is kept apart from the arguments.
    expect([tool.name, tool.arg]).toEqual(["Read", "cli.ts"]);
    expect(tool.result).toEqual(["946 lines", "ok"]);
    expect(tool.done).toBe(true);
    expect((frames[3] as Extract<Frame, { kind: "tool" }>).text).toBe("npm test -- cli");
    expect((frames[3] as Extract<Frame, { kind: "tool" }>).name).toBe("Bash");
    expect((frames[3] as Extract<Frame, { kind: "tool" }>).result).toEqual(["42 passed"]);
    expect(frames[4]).toMatchObject({ kind: "spawn", run: 44, children: [46] });
    expect(frames[0]).toMatchObject({ kind: "user", text: "ship the CLI plan", at: Date.parse(T0) });
  });

  it("keeps a spawn frame even when the result carries no ids", () => {
    const frames = framesFromMessages([
      msg("agent", [{ type: "tool_use", id: "s", name: "spawn__spawn_agent", input: { persona: "qa" } }]),
      msg("tool", [{ type: "tool_result", tool_use_id: "s", content: "Error: depth cap exceeded" }]),
    ]);
    expect(frames).toEqual([{ kind: "spawn", at: Date.parse(T0), run: 44, children: [] }]);
  });

  it("reads start_session's prose result", () => {
    const frames = framesFromMessages([
      msg("agent", [{ type: "tool_use", id: "s", name: "start_session", input: { task_id: "T-0005" } }]),
      msg("tool", [{ type: "tool_result", tool_use_id: "s", content: "Started session #77 on T-0005 (model: default)." }]),
    ]);
    expect(frames[0]).toMatchObject({ kind: "spawn", children: [77] });
  });

  it("folds an unidentified result into the newest open interaction", () => {
    const frames = framesFromMessages([
      msg("agent", [{ type: "tool_use", id: "t1", name: "grep", input: { pattern: "TODO" } }]),
      msg("tool", [{ type: "tool_result", content: "3 matches" }]),
    ]);
    expect(frames[0]).toMatchObject({ kind: "tool", text: "grep TODO", result: ["3 matches"], done: true });
  });

  it("renders a mirrored inbox event as an event frame", () => {
    const frames = framesFromMessages([
      msg(
        "system",
        [
          {
            type: "inbox_event",
            event_id: 1,
            event_type: "gh.ci.completed",
            payload: { conclusion: "failure", check_name: "build" },
          } as unknown as SdkContentBlock,
        ],
        44
      ),
    ]);
    expect(frames[0]).toMatchObject({ kind: "event", tone: "warn", text: "CI failure · build", at: Date.parse(T0) });
  });

  it("names an orchestrator tool by its most identifying argument", () => {
    const frames = framesFromMessages([
      msg("agent", [{ type: "tool_use", id: "a", name: "task_orch__transition_task", input: { task_id: "T-0005", state: "review" } }]),
      msg("agent", [{ type: "tool_use", id: "b", name: "mcp__gmail__search_threads", input: { query: "from:ci" } }]),
    ]);
    expect((frames[0] as Extract<Frame, { kind: "tool" }>).text).toBe("transition_task T-0005");
    // An orchestrator verb keeps the name it was given: `Transition_task` is
    // a worse name than the one the server uses.
    expect((frames[0] as Extract<Frame, { kind: "tool" }>).name).toBe("transition_task");
    expect((frames[0] as Extract<Frame, { kind: "tool" }>).detail).toEqual(["state=review"]);
    expect((frames[1] as Extract<Frame, { kind: "tool" }>).text).toBe("search_threads from:ci");
  });
});

describe("frameFromEvent", () => {
  it("drops stream control frames", () => {
    expect(frameFromEvent(1, { type: "_cursor", cursor: {} })).toBeNull();
    expect(frameFromEvent(1, { type: "_eos" })).toBeNull();
    expect(frameFromEvent(1, { type: "user.message" })).toBeNull();
  });

  it("tones status events by outcome", () => {
    expect(frameFromEvent(44, { type: "status", status: "completed" })).toMatchObject({ tone: "ok", text: "completed" });
    expect(frameFromEvent(44, { type: "status", status: "closed" })).toMatchObject({ tone: "ok" });
    expect(frameFromEvent(44, { type: "status", status: "failed", error: "merge conflict" })).toMatchObject({
      tone: "warn",
      text: "failed: merge conflict",
    });
    expect(frameFromEvent(44, { type: "status", status: "cancelled" })).toMatchObject({ tone: "warn" });
    expect(frameFromEvent(44, { type: "status", status: "running" })).toMatchObject({ tone: "info" });
  });

  it("maps the child and github taxonomy", () => {
    expect(frameFromEvent(42, { type: "child.result", run_id: 44, result: { status: "ok" } })).toMatchObject({
      tone: "ok",
      text: "#44 finished · ok",
    });
    expect(frameFromEvent(42, { type: "child.died", run_id: 44, exit_code: 137 })).toMatchObject({
      tone: "warn",
      text: "#44 died (exit 137)",
    });
    expect(frameFromEvent(42, { type: "gh.pr.merged", pr_url: "x" })).toMatchObject({ tone: "ok", text: "PR merged" });
    expect(frameFromEvent(42, { type: "timer.fired", note: "deadline" })).toMatchObject({ tone: "info" });
  });

  it("shows an unknown type rather than losing it", () => {
    expect(frameFromEvent(42, { type: "custom.deploy_done" })).toMatchObject({
      kind: "event",
      text: "custom deploy done",
    });
  });

  it("turns a child question into a question frame on the asking run", () => {
    const f = frameFromEvent(42, {
      type: "child.question",
      run_id: 45,
      question: "pi or claude?",
      occurred_at: T0,
    });
    expect(f).toEqual({ kind: "question", at: Date.parse(T0), run: 45, text: "pi or claude?" });
  });

  it("unwraps an inbox mirror to the event inside it", () => {
    expect(
      frameFromEvent(42, { type: "inbox_event", event_type: "child.exception", payload: { run_id: 45, code: "E_CONFLICT" } })
    ).toMatchObject({ kind: "event", tone: "warn", text: "#45 raised E_CONFLICT" });
  });
});

describe("appendFrame", () => {
  const tool: Frame = { kind: "tool", at: 1, run: 44, text: "read cli.ts", name: "Read", arg: "cli.ts", detail: [], result: [] };

  it("appends a new frame", () => {
    expect(appendFrame([], tool)).toEqual([tool]);
  });

  it("is idempotent when the same tool_result is folded twice", () => {
    const settled: Frame = { ...tool, result: ["946 lines"], done: true };
    const once = appendFrame([tool], settled);
    expect(once).toEqual([settled]);
    const twice = appendFrame(once, settled);
    expect(twice).toBe(once); // same array: nothing changed
    expect(appendFrame(twice, tool)).toBe(twice);
  });

  it("marks a call finished even when its result says nothing", () => {
    const [settled] = appendFrame([tool], { ...tool, done: true }) as [Extract<Frame, { kind: "tool" }>];
    expect(settled.done).toBe(true);
  });

  it("treats an identical call far later as a new call", () => {
    let frames: Frame[] = [tool];
    for (let i = 0; i < 13; i++) frames = appendFrame(frames, { kind: "event", at: 2, run: 44, text: `e${i}`, tone: "info" });
    frames = appendFrame(frames, tool);
    expect(frames.filter((f) => f.kind === "tool")).toHaveLength(2);
  });

  it("fills a spawn frame's children in place", () => {
    const empty: Frame = { kind: "spawn", at: 1, run: 42, children: [] };
    const filled = appendFrame([empty], { kind: "spawn", at: 1, run: 42, children: [43] });
    expect(filled).toEqual([{ kind: "spawn", at: 1, run: 42, children: [43] }]);
    expect(appendFrame(filled, { kind: "spawn", at: 1, run: 42, children: [43] })).toBe(filled);
  });

  it("coalesces an answer into the open question instead of duplicating it", () => {
    const q: Frame = { kind: "question", at: 1, run: 45, text: "pi or claude?" };
    const asked = appendFrame([], q);
    expect(appendFrame(asked, q)).toBe(asked);
    const answered = appendFrame(asked, { ...q, answered: "pi" });
    expect(answered).toEqual([{ kind: "question", at: 1, run: 45, text: "pi or claude?", answered: "pi" }]);
    expect(appendFrame(answered, { ...q, answered: "pi" })).toBe(answered);
  });

  it("drops the stream's echo of a message the cockpit already showed", () => {
    // The cockpit pushes the typed line optimistically; the server then
    // replays its own copy. The FIRST frame survives, because it is the one
    // carrying the `to` chip the operator aimed the message at.
    const typed: Frame = { kind: "user", at: 1, text: "answer: pi", to: 45 };
    const echo: Frame = { kind: "user", at: 2, text: "answer: pi" };
    const once = appendFrame([], typed);
    expect(appendFrame(once, echo)).toBe(once);
  });

  it("keeps a genuinely repeated message once the window has passed", () => {
    const typed: Frame = { kind: "user", at: 1, text: "again" };
    let frames = appendFrame([], typed);
    expect(appendFrame(frames, { ...typed, at: 2 })).toBe(frames); // still an echo
    for (let i = 0; i < 12; i++) frames = appendFrame(frames, { kind: "agent", at: 3, run: 44, text: `a${i}` });
    frames = appendFrame(frames, { ...typed, at: 9 });
    expect(frames.filter((f) => f.kind === "user")).toHaveLength(2);
  });

  it("keeps two different messages apart", () => {
    const a: Frame = { kind: "user", at: 1, text: "one" };
    const b: Frame = { kind: "user", at: 2, text: "two" };
    expect(appendFrame(appendFrame([], a), b)).toHaveLength(2);
  });

  it("keeps two different questions apart", () => {
    const a: Frame = { kind: "question", at: 1, run: 45, text: "pi or claude?" };
    const b: Frame = { kind: "question", at: 2, run: 45, text: "squash or merge?" };
    expect(appendFrame(appendFrame([], a), b)).toHaveLength(2);
  });
});

describe("spawnedIds prose fallback", () => {
  it("reads the real start_session result", () => {
    expect(spawnedIds("Started session #43 on P-cli (model: default).")).toEqual([43]);
  });

  it("reads a hashless prose result", () => {
    expect(spawnedIds("started run 43")).toEqual([43]);
    expect(spawnedIds("Started session 77")).toEqual([77]);
  });

  it("ignores numbers that are not run ids", () => {
    expect(spawnedIds("read 946 lines")).toEqual([]);
    expect(spawnedIds("+88 −12")).toEqual([]);
  });

  it("still prefers structured ids", () => {
    expect(spawnedIds(JSON.stringify({ run_id: 51 }))).toEqual([51]);
  });
});
