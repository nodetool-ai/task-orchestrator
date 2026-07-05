import { describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

// Reproduces the production failure: a run's resume token points at a session
// transcript that isn't on this machine's disk (volume recycled, or earlier
// turns ran in a different container). The CLI exits with "No conversation
// found with session ID: <id>", which the SDK surfaces as a THROWN stream error
// ("Claude Code returned an error result: ..."). The backend must retry once
// with a fresh session instead of failing the turn.
const sdk = vi.hoisted(() => ({
  calls: [] as any[],
  // Per-test override for the mock stream; null → default behavior below.
  behavior: null as null | ((arg: any) => AsyncGenerator<any>),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (cfg: any) => ({ ...cfg }),
  tool: (name: string) => ({ name }),
  query: (arg: any) => {
    sdk.calls.push(arg);
    if (sdk.behavior) return sdk.behavior(arg);
    // Default: a resumed query dies like the real CLI when the transcript is
    // missing; a fresh query succeeds.
    if (arg.options.resume) {
      return (async function* () {
        throw new Error(
          `Claude Code returned an error result: No conversation found with session ID: ${arg.options.resume}`
        );
      })();
    }
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "fresh-session" };
      yield {
        type: "result",
        subtype: "success",
        result: "recovered",
        num_turns: 1,
        session_id: "fresh-session",
        total_cost_usd: 0.02,
        usage: { input_tokens: 11, output_tokens: 7 },
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
    prompt: "continue with merging",
    onEvent: () => {},
    ...overrides,
  };
}

describe("ClaudeBackend resume-lost fallback", () => {
  it("retries once with a fresh session when the resume transcript is missing", async () => {
    sdk.calls.length = 0;
    sdk.behavior = null;
    const outcome = await new ClaudeBackend().runTurn(
      makeArgs({ resumeToken: "claude:dead-session-id" })
    );

    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[0].options.resume).toBe("dead-session-id");
    expect(sdk.calls[1].options.resume).toBeUndefined();
    // The turn succeeds off the fresh session and yields ITS id as the new
    // token, so the dead id is not replayed on the next turn either.
    expect(outcome.resumeToken).toBe("claude:fresh-session");
    expect(outcome.summary).toBe("recovered");
  });

  it("tells the fresh session its history is gone via the system prompt", async () => {
    sdk.calls.length = 0;
    sdk.behavior = null;
    await new ClaudeBackend().runTurn(makeArgs({ resumeToken: "claude:dead-session-id" }));

    expect(sdk.calls[0].options.systemPrompt.append ?? "").not.toContain("Context recovery");
    expect(sdk.calls[1].options.systemPrompt.append).toContain("Context recovery");
  });

  it("does not retry when there was no resume id (fresh session failed on its own)", async () => {
    sdk.calls.length = 0;
    sdk.behavior = () =>
      (async function* () {
        throw new Error(
          "Claude Code returned an error result: No conversation found with session ID: whatever"
        );
      })();
    await expect(new ClaudeBackend().runTurn(makeArgs())).rejects.toThrow(
      /No conversation found/
    );
    expect(sdk.calls).toHaveLength(1);
    sdk.behavior = null;
  });

  it("rethrows unrelated stream errors without retrying", async () => {
    sdk.calls.length = 0;
    sdk.behavior = () =>
      (async function* () {
        throw new Error("Claude Code process exited with code 1");
      })();
    await expect(
      new ClaudeBackend().runTurn(makeArgs({ resumeToken: "claude:some-id" }))
    ).rejects.toThrow(/exited with code 1/);
    expect(sdk.calls).toHaveLength(1);
    sdk.behavior = null;
  });

  it("gives up after the single fresh retry if that fails too", async () => {
    sdk.calls.length = 0;
    // Both attempts die with the resume-lost error (fresh one can't, in
    // reality, but the retry must be bounded regardless).
    sdk.behavior = () =>
      (async function* () {
        throw new Error(
          "Claude Code returned an error result: No conversation found with session ID: x"
        );
      })();
    await expect(
      new ClaudeBackend().runTurn(makeArgs({ resumeToken: "claude:x" }))
    ).rejects.toThrow(/No conversation found/);
    expect(sdk.calls).toHaveLength(2);
    sdk.behavior = null;
  });
});
