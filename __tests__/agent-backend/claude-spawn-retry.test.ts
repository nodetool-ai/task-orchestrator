import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend, __test } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

// Reproduces run 26: the SDK's child process dies at spawn ("Claude Code native
// binary at <path> exists but failed to launch", surfaced as a thrown
// ReferenceError before any model work happens). That is an infrastructure
// fault — a just-forked box snapshot whose binary isn't ready — not an agent
// error, so the backend must retry the launch (bounded, with settle delays)
// instead of failing the run 23 ms into its first turn.
const SPAWN_ERR =
  "Claude Code native binary at /home/user/task-orchestrator/node_modules/" +
  "@anthropic-ai/claude-agent-sdk-linux-x64/claude exists but failed to launch. " +
  "This usually means the binary does not match this system's libc";

type Behavior = "spawn-fail" | "resume-lost" | "ok";

const sdk = vi.hoisted(() => ({
  calls: [] as any[],
  // One entry consumed per query() call; empty → "ok".
  script: [] as ("spawn-fail" | "resume-lost" | "ok")[],
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (cfg: any) => ({ ...cfg }),
  tool: (name: string) => ({ name }),
  query: (arg: any) => {
    sdk.calls.push(arg);
    const behavior = sdk.script.shift() ?? "ok";
    if (behavior === "spawn-fail") {
      return (async function* () {
        throw new ReferenceError(SPAWN_ERR);
      })();
    }
    if (behavior === "resume-lost") {
      return (async function* () {
        throw new Error(
          `Claude Code returned an error result: No conversation found with session ID: ${arg.options.resume}`
        );
      })();
    }
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "result",
        subtype: "success",
        result: "launched fine",
        num_turns: 1,
        session_id: "s1",
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    })();
  },
}));

function makeArgs(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "do the thing",
    onEvent: () => {},
    ...overrides,
  };
}

function script(...behaviors: Behavior[]): void {
  sdk.calls.length = 0;
  sdk.script = behaviors;
}

afterEach(() => {
  sdk.calls.length = 0;
  sdk.script = [];
  __test.setSpawnRetryDelays(null);
});

describe("ClaudeBackend spawn-failure retry", () => {
  it("retries the launch after a spawn failure and completes the turn", async () => {
    __test.setSpawnRetryDelays([0, 0]);
    script("spawn-fail", "ok");

    const outcome = await new ClaudeBackend().runTurn(makeArgs());

    expect(sdk.calls).toHaveLength(2);
    expect(outcome.summary).toBe("launched fine");
  });

  it("gives up after the bounded retries with an infrastructure-flagged error", async () => {
    __test.setSpawnRetryDelays([0, 0]);
    script("spawn-fail", "spawn-fail", "spawn-fail");

    await expect(new ClaudeBackend().runTurn(makeArgs())).rejects.toThrow(/infrastructure/i);
    // initial attempt + one retry per configured delay
    expect(sdk.calls).toHaveLength(3);
  });

  it("keeps the resume id and does not inject the context-loss note on spawn retries", async () => {
    __test.setSpawnRetryDelays([0]);
    script("spawn-fail", "ok");

    await new ClaudeBackend().runTurn(makeArgs({ resumeToken: "claude:keep-me" }));

    expect(sdk.calls).toHaveLength(2);
    // A spawn failure says nothing about the transcript: the retry must still
    // resume the same session, with no "Context recovery" note.
    expect(sdk.calls[1].options.resume).toBe("keep-me");
    expect(sdk.calls[1].options.systemPrompt.append ?? "").not.toContain("Context recovery");
  });

  it("still falls back to a fresh session when a spawn retry then hits resume-lost", async () => {
    __test.setSpawnRetryDelays([0]);
    script("spawn-fail", "resume-lost", "ok");

    const outcome = await new ClaudeBackend().runTurn(makeArgs({ resumeToken: "claude:keep-me" }));

    // spawn-fail → spawn retry (resumed → resume-lost) → fresh-session retry
    expect(sdk.calls).toHaveLength(3);
    expect(sdk.calls[1].options.resume).toBe("keep-me");
    expect(sdk.calls[2].options.resume).toBeUndefined();
    expect(outcome.summary).toBe("launched fine");
  });
});

describe("spawn-failure classification", () => {
  // With pathToClaudeCodeExecutable set, the SDK's launch errors use
  // different text than the bundled-binary path. All of them are
  // infrastructure faults and must be retryable.
  it("classifies bundled-binary, explicit-path, and generic spawn errors as retryable", () => {
    const retryable = [
      SPAWN_ERR, // bundled: "native binary at <path> exists but failed to launch"
      "Claude Code executable at /usr/local/bin/claude exists but failed to launch",
      "Claude Code executable not found at /usr/local/bin/claude. Is options.pathToClaudeCodeExecutable set correctly?",
      "Failed to spawn Claude Code process: EAGAIN",
    ];
    for (const msg of retryable) {
      expect(__test.isSpawnFailure(msg), msg).toBe(true);
    }
  });

  it("does not classify ordinary agent errors as spawn failures", () => {
    expect(__test.isSpawnFailure("API rate limit exceeded")).toBe(false);
    expect(__test.isSpawnFailure("No conversation found with session ID: abc")).toBe(false);
  });
});
