import { describe, expect, it } from "vitest";
import {
  buildClaudeCommand,
  buildHookSettings,
  computeTranscriptPath,
  detectNeedsHuman,
  shellQuote,
  tmuxSessionName,
} from "../lib/claude-cli";

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("/tmp/plain")).toBe("'/tmp/plain'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("buildClaudeCommand", () => {
  const cmd = buildClaudeCommand({
    claudeBin: "claude",
    stateDir: "/tmp/task-orch/claude-run-7",
    sessionId: "11111111-2222-3333-4444-555555555555",
  });

  it("runs claude with skip-permissions, session id, and settings file", () => {
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--session-id '11111111-2222-3333-4444-555555555555'");
    expect(cmd).toContain("--settings '/tmp/task-orch/claude-run-7/settings.json'");
  });

  it("injects the prompt via cat from the state dir, not inline", () => {
    expect(cmd).toContain(`"$(cat '/tmp/task-orch/claude-run-7/prompt.md')"`);
  });

  it("records the exit code and keeps the pane alive with a shell", () => {
    expect(cmd).toContain("echo $? > '/tmp/task-orch/claude-run-7/exit-code'");
    expect(cmd).toContain('exec "${SHELL:-sh}" -i');
  });

  it("quotes a state dir containing spaces", () => {
    const spaced = buildClaudeCommand({
      claudeBin: "claude",
      stateDir: "/tmp/with space/run-1",
      sessionId: "x",
    });
    expect(spaced).toContain("'/tmp/with space/run-1/prompt.md'");
  });
});

describe("buildHookSettings", () => {
  const settings = buildHookSettings({
    runId: 42,
    hookToken: "secret-token",
    baseUrl: "http://localhost:3000/",
  }) as any;

  it("registers SessionStart, Stop, and SessionEnd hooks", () => {
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "SessionEnd",
      "SessionStart",
      "Stop",
    ]);
  });

  it("curls the run's hook endpoint with the bearer token and stdin payload", () => {
    const command = settings.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("'http://localhost:3000/api/runs/42/hook'");
    expect(command).toContain("'Authorization: Bearer secret-token'");
    expect(command).toContain("--data-binary @-");
    // a dead orchestrator must not surface errors inside the Claude TUI
    expect(command).toContain("|| true");
  });

  it("normalizes a trailing slash on the base url", () => {
    const command = settings.hooks.SessionStart[0].hooks[0].command as string;
    expect(command).not.toContain("3000//api");
  });
});

describe("computeTranscriptPath", () => {
  it("munges every non-alphanumeric cwd character to '-'", () => {
    const p = computeTranscriptPath("/repo/.worktrees/42", "abc-123");
    expect(p).toContain("/.claude/projects/-repo--worktrees-42/abc-123.jsonl");
  });
});

describe("tmuxSessionName", () => {
  it("derives from the run id", () => {
    expect(tmuxSessionName(17)).toBe("torch-run-17");
  });
});

describe("detectNeedsHuman", () => {
  it("detects login screens", () => {
    expect(detectNeedsHuman("│ Select login method:  │")).toBe("login");
    expect(detectNeedsHuman("Paste code here if prompted >")).toBe("login");
  });

  it("detects re-auth screens", () => {
    expect(detectNeedsHuman("Invalid API key · Please run /login")).toBe("reauth");
    expect(detectNeedsHuman("OAuth token expired.")).toBe("reauth");
  });

  it("detects the bypass-permissions consent screen", () => {
    expect(
      detectNeedsHuman("WARNING: Bypass Permissions mode disables …")
    ).toBe("bypass-consent");
    expect(detectNeedsHuman("  1. No, exit\n  2. Yes, I accept")).toBe(
      "bypass-consent"
    );
  });

  it("returns null for ordinary working output", () => {
    const pane = [
      "✻ Welcome to Claude Code!",
      "> Implement the feature",
      "● Bash(npm test)",
      "  ⎿ 12 passing",
    ].join("\n");
    expect(detectNeedsHuman(pane)).toBeNull();
  });
});
