import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

function makeArgs(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "hi",
    onEvent: () => {},
    ...overrides,
  };
}

describe("ClaudeBackend.runTurn guards", () => {
  // The backend no longer requires ANTHROPIC_API_KEY: auth is inherited from
  // the env and resolved like Claude Code (API key when set, otherwise the
  // claude.ai subscription). So there is no "missing key" guard to test — and
  // asserting against a real run() would issue a billed API call.
  it("rejects a non-anthropic provider before reaching the SDK", async () => {
    // This throws at the provider guard, before the SDK is imported or any
    // network call is made — safe to assert without mocking.
    await expect(
      new ClaudeBackend().runTurn(
        makeArgs({ model: { provider: "openai", id: "gpt-4o" } })
      )
    ).rejects.toThrow(/only supports the 'anthropic' provider/);
  });
});
