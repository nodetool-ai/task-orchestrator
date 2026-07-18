// __tests__/agent-backend/claude-binary-wiring.test.ts
//
// The backend must hand TASK_ORCH_CLAUDE_BINARY to the SDK as
// pathToClaudeCodeExecutable — and validate it at construction, so a bad
// path fails with an actionable error instead of a mid-run spawn error.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

const sdk = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (cfg: any) => ({ ...cfg }),
  tool: (name: string) => ({ name }),
  query: (arg: any) => {
    sdk.calls.push(arg);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        num_turns: 1,
        session_id: "s1",
        total_cost_usd: 0.01,
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    })();
  },
}));

function makeArgs(): RunTurnArgs {
  return {
    cwd: "/tmp",
    model: { provider: "anthropic", id: "claude-opus-4-8" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "do the thing",
    onEvent: () => {},
  };
}

let dir: string;
let savedEnv: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-wiring-"));
  savedEnv = process.env.TASK_ORCH_CLAUDE_BINARY;
  delete process.env.TASK_ORCH_CLAUDE_BINARY;
  sdk.calls.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedEnv == null) delete process.env.TASK_ORCH_CLAUDE_BINARY;
  else process.env.TASK_ORCH_CLAUDE_BINARY = savedEnv;
});

describe("ClaudeBackend external binary wiring", () => {
  it("passes pathToClaudeCodeExecutable when TASK_ORCH_CLAUDE_BINARY is set", async () => {
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\necho fake-claude 1.0.0\n");
    chmodSync(bin, 0o755);
    process.env.TASK_ORCH_CLAUDE_BINARY = bin;

    await new ClaudeBackend().runTurn(makeArgs());

    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].options.pathToClaudeCodeExecutable).toBe(bin);
  });

  it("omits pathToClaudeCodeExecutable when unset (SDK bundled binary)", async () => {
    await new ClaudeBackend().runTurn(makeArgs());
    expect(sdk.calls[0].options.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it("fails at construction — not mid-run — when the configured path is broken", () => {
    process.env.TASK_ORCH_CLAUDE_BINARY = join(dir, "no-such-claude");
    expect(() => new ClaudeBackend()).toThrow(/TASK_ORCH_CLAUDE_BINARY/);
    expect(sdk.calls).toHaveLength(0);
  });
});
