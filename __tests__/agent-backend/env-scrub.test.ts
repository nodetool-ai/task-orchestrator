import { describe, expect, it } from "vitest";
import {
  SECRET_ENV_DENYLIST,
  bashUnsetPrefix,
  scrubClaudeCliEnv,
  scrubEnv,
} from "../../lib/agent-backend/env-scrub";

describe("SECRET_ENV_DENYLIST", () => {
  it("includes server-only secrets", () => {
    expect(SECRET_ENV_DENYLIST).toContain("DATABASE_URL");
    expect(SECRET_ENV_DENYLIST).toContain("FLY_API_TOKEN");
    expect(SECRET_ENV_DENYLIST).toContain("AUTH_SECRET");
    expect(SECRET_ENV_DENYLIST).toContain("GITHUB_WEBHOOK_SECRET");
  });

  it("includes model-provider credentials", () => {
    expect(SECRET_ENV_DENYLIST).toContain("ANTHROPIC_API_KEY");
    expect(SECRET_ENV_DENYLIST).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(SECRET_ENV_DENYLIST).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(SECRET_ENV_DENYLIST).toContain("OPENAI_API_KEY");
    expect(SECRET_ENV_DENYLIST).toContain("CODEX_ACCESS_TOKEN");
    expect(SECRET_ENV_DENYLIST).toContain("GEMINI_API_KEY");
    expect(SECRET_ENV_DENYLIST).toContain("COPILOT_GITHUB_TOKEN");
    expect(SECRET_ENV_DENYLIST).toContain("AZURE_OPENAI_API_KEY");
  });

  it("keeps GH_TOKEN and GITHUB_TOKEN out (git credential helper / gh CLI need them)", () => {
    expect(SECRET_ENV_DENYLIST).not.toContain("GH_TOKEN");
    expect(SECRET_ENV_DENYLIST).not.toContain("GITHUB_TOKEN");
  });

  it("has no duplicates", () => {
    expect(new Set(SECRET_ENV_DENYLIST).size).toBe(SECRET_ENV_DENYLIST.length);
  });
});

describe("scrubEnv", () => {
  it("removes every denylisted key, keeping everything else", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/root",
      DATABASE_URL: "postgres://leak",
      ANTHROPIC_API_KEY: "sk-ant-leak",
      CODEX_ACCESS_TOKEN: "codex-leak",
      GH_TOKEN: "gh-keep",
      GITHUB_TOKEN: "ghtok-keep",
    };
    const result = scrubEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/root");
    expect(result.GH_TOKEN).toBe("gh-keep");
    expect(result.GITHUB_TOKEN).toBe("ghtok-keep");
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.CODEX_ACCESS_TOKEN).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const env = { DATABASE_URL: "leak", PATH: "/usr/bin" };
    const result = scrubEnv(env);
    expect(env.DATABASE_URL).toBe("leak");
    expect(result).not.toBe(env);
  });
});

describe("bashUnsetPrefix", () => {
  it("emits a single unset covering the full denylist, newline-terminated", () => {
    const prefix = bashUnsetPrefix();
    expect(prefix.startsWith("unset ")).toBe(true);
    expect(prefix.endsWith("\n")).toBe(true);
    for (const key of SECRET_ENV_DENYLIST) {
      expect(prefix).toContain(key);
    }
    // Single unset invocation, not one per line.
    expect(prefix.match(/unset /g)?.length).toBe(1);
  });
});

describe("scrubClaudeCliEnv", () => {
  it("keeps Anthropic/Claude auth keys", () => {
    const result = scrubClaudeCliEnv({
      ANTHROPIC_API_KEY: "sk-ant-keep",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-keep",
      ANTHROPIC_OAUTH_TOKEN: "oauth2-keep",
    });
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-keep");
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-keep");
    expect(result.ANTHROPIC_OAUTH_TOKEN).toBe("oauth2-keep");
  });

  it("drops DATABASE_URL, OPENAI_API_KEY, and FLY_API_TOKEN", () => {
    const result = scrubClaudeCliEnv({
      DATABASE_URL: "postgres://leak",
      OPENAI_API_KEY: "sk-openai-leak",
      FLY_API_TOKEN: "fly-leak",
    });
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.FLY_API_TOKEN).toBeUndefined();
  });

  it("keeps PATH, HOME, and GH_TOKEN", () => {
    const result = scrubClaudeCliEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      GH_TOKEN: "gh-keep",
    });
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/root");
    expect(result.GH_TOKEN).toBe("gh-keep");
  });

  it("respects caller-supplied args.env but still scrubs it", () => {
    // Simulates claude-backend.ts's `{ ...process.env, ...args.env }` merge:
    // a caller-supplied entry survives the merge but must still be scrubbed
    // if it's a denylisted name, and kept if it's a harmless override.
    const merged = {
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://leak",
      CUSTOM_FLAG: "from-caller",
    };
    const result = scrubClaudeCliEnv(merged);
    expect(result.CUSTOM_FLAG).toBe("from-caller");
    expect(result.DATABASE_URL).toBeUndefined();
  });
});
