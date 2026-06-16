import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

const ORIG_KEY = process.env.ANTHROPIC_API_KEY;

function makeArgs(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-6" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "hi",
    onEvent: () => {},
    ...overrides,
  };
}

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIG_KEY;
});

describe("ClaudeBackend.runTurn guards", () => {
  it("throws an actionable error when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(new ClaudeBackend().runTurn(makeArgs())).rejects.toThrow(
      /ANTHROPIC_API_KEY is required/
    );
  });

  describe("with an API key present", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
    });

    it("rejects a non-anthropic provider before reaching the SDK", async () => {
      await expect(
        new ClaudeBackend().runTurn(
          makeArgs({ model: { provider: "openai", id: "gpt-4o" } })
        )
      ).rejects.toThrow(/only supports the 'anthropic' provider/);
    });
  });
});
