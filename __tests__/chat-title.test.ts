import { describe, expect, it } from "vitest";
import { deriveTitle, generateChatTitle } from "../lib/chat-title";

// deriveTitle is the deterministic floor for chat auto-naming: it must always
// produce a clean, single-line, bounded title so a chat never shows the raw
// message or the "New chat" placeholder once it has a first message.
describe("deriveTitle", () => {
  it("passes short single-line messages through unchanged", () => {
    expect(deriveTitle("Fix the login redirect bug")).toBe("Fix the login redirect bug");
  });

  it("collapses whitespace and newlines to a single line", () => {
    expect(deriveTitle("  Help   me\n\nwrite  a\ttest  ")).toBe("Help me write a test");
  });

  it("strips markdown fences, emphasis, and leading list/heading markers", () => {
    expect(deriveTitle("# Deploy plan")).toBe("Deploy plan");
    expect(deriveTitle("- **refactor** the `parser`")).toBe("refactor the parser");
    expect(deriveTitle("How do I use ```const x = 1``` here")).toBe("How do I use here");
  });

  it("truncates long messages on a word boundary with an ellipsis", () => {
    const title = deriveTitle(
      "Please help me understand why the authentication middleware keeps rejecting valid tokens"
    );
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    // Ends on a whole word, not mid-word.
    expect(title).toBe("Please help me understand why the authentication…");
  });

  it("hard-truncates a single very long word within budget", () => {
    const title = deriveTitle("a".repeat(200));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("returns empty for content with no visible characters", () => {
    expect(deriveTitle("   \n\t  ")).toBe("");
    expect(deriveTitle("```\ncode only\n```")).toBe("");
  });
});

// generateChatTitle is best-effort and must degrade to null (never throw) when
// no provider credential is present — the caller then keeps the derived title.
describe("generateChatTitle", () => {
  const CRED_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"];

  it("returns null when no credential is configured", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of CRED_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      await expect(generateChatTitle("Fix the login bug")).resolves.toBeNull();
    } finally {
      for (const k of CRED_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  });

  it("returns null for an empty message", async () => {
    await expect(generateChatTitle("   ")).resolves.toBeNull();
  });
});
