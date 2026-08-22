// The verbs end to end, minus the process: a fake client, two string sinks
// for stdout and stderr, and the exit code as a return value. What is checked
// is the contract PRD §6.5 states — data on stdout, diagnostics on stderr,
// 0/1/2 — plus the two behaviours that would be expensive to get wrong:
// `spawn` never creates a run, and `tail` follows until it is stopped.

import { describe, expect, it } from "vitest";
import { ApiError, UnauthorizedError, type OrchClient, type RunEventHandlers, type Subscription } from "../../src/api/client.js";
import type {
  CreateRunInput,
  GlobalInboxRow,
  MessageRow,
  PersonaSummary,
  RunDetail,
  RunIndexRow,
  RunRow,
} from "../../src/api/types.js";
import { parseCli, type CliCommand } from "../../src/cli/parse.js";
import { exitCodeFor, runCommand, type ExitCode } from "../../src/cli/run.js";

const NOW = Date.parse("2026-03-02T12:00:00.000Z");

interface Fake {
  client: OrchClient;
  /** Everything the fake was asked to do, in order. */
  calls: string[];
  /** The live run stream, so a test can push frames into a tail. */
  handlers: RunEventHandlers | null;
  closed: number;
}

function fakeClient(over: Partial<OrchClient> = {}): Fake {
  const fake: Fake = { client: null as unknown as OrchClient, calls: [], handlers: null, closed: 0 };
  const note = <T>(name: string, value: T) => {
    fake.calls.push(name);
    return value;
  };
  const unused = (name: string) => () => {
    throw new Error(`${name} should not be called`);
  };
  fake.client = {
    overview: async () => note("overview", [] as RunIndexRow[]),
    listRuns: unused("listRuns"),
    run: unused("run"),
    runInbox: unused("runInbox"),
    inbox: async () => note("inbox", [] as GlobalInboxRow[]),
    tasks: unused("tasks"),
    plans: unused("plans"),
    personas: async () => note("personas", [] as PersonaSummary[]),
    sendMessage: async (id: number, text: string) => void note(`sendMessage ${id} ${text}`, null),
    createRun: unused("createRun") as unknown as (input: CreateRunInput) => Promise<RunRow>,
    cancelRun: unused("cancelRun") as unknown as (id: number) => Promise<RunRow>,
    overviewEvents: unused("overviewEvents") as unknown as OrchClient["overviewEvents"],
    runEvents: (id, _cursor, h): Subscription => {
      fake.calls.push(`runEvents ${id}`);
      fake.handlers = h;
      return {
        close() {
          fake.closed++;
        },
      };
    },
    ...over,
  };
  return fake;
}

interface Result {
  code: ExitCode;
  out: string[];
  err: string[];
}

async function run(argv: string[], fake: Fake, signal?: AbortSignal): Promise<Result> {
  const cmd = parseCli(argv) as CliCommand;
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(cmd, {
    client: fake.client,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => NOW,
    signal,
  });
  return { code, out, err };
}

const runRow = (over: Partial<RunRow> & { id: number }): RunRow => ({
  goal: "goal",
  status: "running",
  title: null,
  personaId: "planner",
  parentRunId: null,
  model: null,
  taskId: null,
  planId: null,
  prUrl: null,
  totalCostUsd: null,
  startedAt: null,
  completedAt: null,
  ...over,
});

const overviewRow = (id: number): RunIndexRow => ({
  id,
  goal: "goal",
  status: "running",
  origin: "chat",
  title: `run ${id}`,
  taskId: null,
  taskTitle: null,
  planId: null,
  planTitle: null,
  repoId: null,
  repoName: null,
  parentRunId: null,
  prUrl: null,
  model: null,
  totalCostUsd: 0,
  error: null,
  startedAt: new Date(NOW - 60_000).toISOString(),
  completedAt: null,
  parkReason: null,
  pendingReason: null,
  pendingEvents: 0,
  personaId: "implementor",
  personaName: "Implementor",
});

describe("floor and inbox", () => {
  it("writes rows to stdout and nothing to stderr", async () => {
    const fake = fakeClient({ overview: async () => [overviewRow(1), overviewRow(2)] });
    const r = await run(["floor"], fake);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(2);
    expect(r.err).toEqual([]);
  });

  it("writes exactly one JSON document under --json", async () => {
    const fake = fakeClient({ overview: async () => [overviewRow(1), overviewRow(2)] });
    const r = await run(["floor", "--json"], fake);
    expect(r.out).toHaveLength(1);
    const parsed = JSON.parse(r.out[0]) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it("prints an empty array, not nothing, when a list is empty", async () => {
    const r = await run(["inbox", "--json"], fakeClient());
    expect(r.out).toEqual(["[]"]);
    expect(r.code).toBe(0);
  });
});

describe("exit codes", () => {
  it("maps a server error to 2 and a 401 to 1", async () => {
    const boom = fakeClient({
      overview: async () => {
        throw new ApiError(500, "boom", null);
      },
    });
    const server = await run(["floor"], boom);
    expect(server.code).toBe(2);
    expect(server.out).toEqual([]);
    expect(server.err[0]).toContain("boom");

    const denied = fakeClient({
      overview: async () => {
        throw new UnauthorizedError(null, "Unauthorized");
      },
    });
    const auth = await run(["floor"], denied);
    expect(auth.code).toBe(1);
    expect(auth.err[0]).toContain("unauthorized");
  });

  it("maps a network failure to 2", async () => {
    const down = fakeClient({
      overview: async () => {
        throw new Error("fetch failed");
      },
    });
    expect((await run(["floor"], down)).code).toBe(2);
    expect(exitCodeFor(new Error("fetch failed"))).toBe(2);
  });

  it("maps bad argv to 1 with the usage on stderr", async () => {
    const r = await run(["tail", "banana"], fakeClient());
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err[0]).toContain("usage: orch tail <id>");
  });

  it("prints help on stdout and exits 0", async () => {
    const r = await run(["--help"], fakeClient());
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("orch tail <id>");
    expect(r.err).toEqual([]);
  });
});

describe("say, spawn, new, cancel", () => {
  it("says nothing on success, because stdout is for data", async () => {
    const fake = fakeClient();
    const r = await run(["say", "45", "use", "pi"], fake);
    expect(r).toMatchObject({ code: 0, out: [], err: [] });
    expect(fake.calls).toEqual(["sendMessage 45 use pi"]);
  });

  // T-tui-08: the orchestrator owns the spawn tool. A CLI that created the
  // child itself would produce a run the parent does not know it has.
  it("spawn posts a user message and never creates a run", async () => {
    const fake = fakeClient();
    const r = await run(["spawn", "43", "implementor", "T-0006"], fake);
    expect(r.code).toBe(0);
    expect(fake.calls).toEqual([
      "sendMessage 43 Spawn a implementor sub-agent for task T-0006 using the spawn tool.",
    ]);
  });

  it("new prints the id of the run it started", async () => {
    const fake = fakeClient({
      personas: async () => [persona("planner")],
      createRun: async (input: CreateRunInput) => {
        expect(input).toMatchObject({ goal: "ship the CLI", personaId: "planner", cwdStrategy: "none" });
        return runRow({ id: 77 });
      },
    });
    const r = await run(["new", "planner", "ship the CLI"], fake);
    expect(r).toMatchObject({ code: 0, out: ["77"] });
  });

  it("new refuses an unknown persona before it POSTs anything", async () => {
    const fake = fakeClient({ personas: async () => [persona("planner")] });
    const r = await run(["new", "architekt", "ship it"], fake);
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("architekt");
    // The fake's createRun throws if it is ever reached, so exit 1 (not 2) is
    // the proof that nothing was POSTed.
    expect(fake.calls).not.toContain("createRun");
  });

  it("cancel patches the run and answers a document under --json", async () => {
    const fake = fakeClient({ cancelRun: async (id: number) => runRow({ id, status: "cancelled" }) });
    expect(await run(["cancel", "43"], fake)).toMatchObject({ code: 0, out: [] });
    const json = await run(["cancel", "43", "--json"], fake);
    expect(JSON.parse(json.out[0])).toEqual({ ok: true, id: 43, status: "cancelled" });
  });
});

describe("tail", () => {
  const detail = (messages: MessageRow[]): RunDetail =>
    ({
      id: 44,
      goal: "goal",
      status: "running",
      title: null,
      taskId: null,
      planId: null,
      parentRunId: null,
      personaId: "implementor",
      prUrl: null,
      model: null,
      totalCostUsd: null,
      error: null,
      startedAt: new Date(NOW).toISOString(),
      completedAt: null,
      parkReason: null,
      budgetMaxUsd: null,
      budgetMaxTurns: null,
      messages,
      live: true,
    }) as RunDetail;

  const message = (id: number, over: Partial<MessageRow>): MessageRow => ({
    id,
    runId: 44,
    role: "agent",
    content: [],
    createdAt: new Date(NOW).toISOString(),
    ...over,
  });

  it("prints the transcript so far, then follows until ^c", async () => {
    const fake = fakeClient({
      run: async () => detail([message(1, { role: "user", content: [{ type: "text", text: "use pi" }] })]),
    });
    const stop = new AbortController();
    const pending = run(["tail", "44"], fake, stop.signal);
    await Promise.resolve(); // let the batch land and the stream open

    fake.handlers?.onMessage(message(2, { content: [{ type: "text", text: "on it" }] }));
    fake.handlers?.onEvent({ type: "status", status: "completed" });
    stop.abort();

    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["> use pi", "implementor: on it", "  · completed"]);
    expect(fake.closed).toBe(1); // the subscription does not outlive the verb
  });

  it("does not print the same frame twice when the stream replays it", async () => {
    const tool = message(3, {
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
    });
    const fake = fakeClient({ run: async () => detail([tool]) });
    const stop = new AbortController();
    const pending = run(["tail", "44"], fake, stop.signal);
    await Promise.resolve();

    fake.handlers?.onMessage(tool); // a resumed stream can repeat the tail of the batch
    stop.abort();
    expect((await pending).out).toEqual(["  ⎿ npm test"]);
  });

  it("streams one JSON document per line under --json", async () => {
    const fake = fakeClient({ run: async () => detail([]) });
    const stop = new AbortController();
    const pending = run(["tail", "44", "--json"], fake, stop.signal);
    await Promise.resolve();

    fake.handlers?.onEvent({ type: "status", status: "completed" });
    stop.abort();
    const r = await pending;
    expect(JSON.parse(r.out[0])).toMatchObject({ kind: "event", run: 44, text: "completed", persona: "implementor" });
  });

  it("ends with 1 when the stream says the token is no good", async () => {
    const fake = fakeClient({ run: async () => detail([]) });
    const pending = run(["tail", "44"], fake);
    await Promise.resolve();
    fake.handlers?.onError?.(new UnauthorizedError(null, "Unauthorized"));
    const r = await pending;
    expect(r.code).toBe(1);
    expect(r.err[0]).toContain("unauthorized");
  });

  it("returns 2 when the run itself cannot be read", async () => {
    const fake = fakeClient({
      run: async () => {
        throw new ApiError(404, "Run not found", null);
      },
    });
    const r = await run(["tail", "999"], fake);
    expect(r).toMatchObject({ code: 2, out: [] });
    expect(r.err[0]).toContain("Run not found");
  });
});

function persona(id: string): PersonaSummary {
  return {
    id,
    name: id,
    description: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    toolsProfile: null,
    backend: null,
    budgetMaxTurns: null,
    budgetMaxSeconds: null,
  };
}
