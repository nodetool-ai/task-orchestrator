// The deployment authenticates Anthropic the Claude Code way
// (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`). pi's anthropic provider
// reads only ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY, so a pi-backed run with
// an Anthropic model saw no credential at all — prod run 190 failed with "No
// API key found for anthropic" while the token sat in the same process env
// under the other name.
//
// applyClaudeCodeAnthropicFallback closes that gap for IN-PROCESS pi turns;
// worker processes get the same credential through the ANTHROPIC_OAUTH_TOKEN
// alias in agentCredentialEnv (provider-env.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { applyClaudeCodeAnthropicFallback } from "../../lib/agent-backend/pi-backend";

/** The two AuthStorage members the fallback touches. */
function fakeStorage(hasAuth: boolean) {
  return {
    hasAuth: () => hasAuth,
    setRuntimeApiKey: vi.fn(),
  };
}

describe("applyClaudeCodeAnthropicFallback", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hands the Claude Code token to pi when anthropic has no auth", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    const storage = fakeStorage(false);
    applyClaudeCodeAnthropicFallback(storage as never);
    expect(storage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-oat01-test");
  });

  // A runtime override outranks every other source in pi's AuthStorage, so a
  // stored `pi login` credential or a real ANTHROPIC_* env var must still win.
  it("leaves an already configured anthropic credential alone", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-test");
    const storage = fakeStorage(true);
    applyClaudeCodeAnthropicFallback(storage as never);
    expect(storage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("does nothing without a Claude Code token", () => {
    const storage = fakeStorage(false);
    applyClaudeCodeAnthropicFallback(storage as never);
    expect(storage.setRuntimeApiKey).not.toHaveBeenCalled();
  });
});
