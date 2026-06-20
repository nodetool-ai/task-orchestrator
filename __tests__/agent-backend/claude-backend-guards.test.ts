import { describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../../lib/agent-backend/claude-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

// Capture the options handed to the SDK's query() without issuing a real
// (billed) call. The backend dynamically imports the SDK, so the mock must
// stand in for the whole module.
const sdk = vi.hoisted(() => ({ captured: null as any }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (cfg: any) => ({ ...cfg }),
  tool: (name: string) => ({ name }),
  query: (arg: any) => {
    sdk.captured = arg;
    // Empty stream: runTurn finishes immediately and returns its outcome.
    return (async function* () {})();
  },
}));

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

  it("isolates the run to the in-process orchestrator server (no ambient MCP leakage)", async () => {
    // Regression: a "task-orchestrator" MCP server in the user's ~/.claude.json
    // (e.g. pointed at a remote deployment) used to be loaded by the claude_code
    // preset, so the agent wrote plans/tasks to that remote DB while this
    // instance showed nothing. strictMcpConfig must lock the run to our server.
    sdk.captured = null;
    await new ClaudeBackend().runTurn(makeArgs());
    expect(sdk.captured.options.strictMcpConfig).toBe(true);
    expect(Object.keys(sdk.captured.options.mcpServers)).toEqual(["task_orch"]);
  });
});
