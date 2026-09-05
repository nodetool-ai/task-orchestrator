import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_ACCOUNT_ID_ENV,
  CODEX_HOME_OVERRIDE_ENV,
  CODEX_ID_TOKEN_ENV,
  CODEX_REFRESH_TOKEN_ENV,
  chatGptAuthJson,
  codexAuthMode,
  codexHomeFor,
  resolveCodexAuth,
} from "../../lib/agent-backend/codex-auth";

const created: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auth-test-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("codexAuthMode", () => {
  it("prefers an explicit API key over a forwarded ChatGPT token", () => {
    expect(codexAuthMode({ OPENAI_API_KEY: "sk-x", CODEX_ACCESS_TOKEN: "tok" })).toBe("api-key");
    expect(codexAuthMode({ CODEX_API_KEY: "sk-x" })).toBe("api-key");
  });

  it("uses the forwarded ChatGPT token when there is no API key", () => {
    expect(codexAuthMode({ CODEX_ACCESS_TOKEN: "tok" })).toBe("chatgpt");
  });

  it("falls back to the machine's own Codex setup when we hold nothing", () => {
    expect(codexAuthMode({})).toBe("ambient");
    // Blank strings are not credentials.
    expect(codexAuthMode({ OPENAI_API_KEY: "  ", CODEX_ACCESS_TOKEN: "" })).toBe("ambient");
  });
});

describe("codexHomeFor", () => {
  it("keeps runs out of ~/.codex so our auth.json cannot clobber `codex login`", () => {
    const home = codexHomeFor("chatgpt", { HOME: "/home/u" });
    expect(home).toBe("/home/u/.task-orchestrator/codex");
  });

  it("defers to the machine's CODEX_HOME only when we have no credential to install", () => {
    expect(codexHomeFor("ambient", { HOME: "/home/u", CODEX_HOME: "/custom" })).toBe("/custom");
    expect(codexHomeFor("ambient", { HOME: "/home/u" })).toBe("/home/u/.codex");
  });

  it("honours the operator override in every mode", () => {
    for (const mode of ["api-key", "chatgpt", "ambient"] as const) {
      expect(codexHomeFor(mode, { HOME: "/home/u", [CODEX_HOME_OVERRIDE_ENV]: "/opt/codex" })).toBe(
        "/opt/codex"
      );
    }
  });
});

describe("chatGptAuthJson", () => {
  it("writes the token set in the shape `codex login` produces", () => {
    const parsed = JSON.parse(
      chatGptAuthJson({
        accessToken: "at",
        idToken: "it",
        refreshToken: "rt",
        accountId: "acct",
        now: new Date("2026-01-02T03:04:05.000Z"),
      })
    );
    expect(parsed).toEqual({
      OPENAI_API_KEY: null,
      tokens: { id_token: "it", access_token: "at", refresh_token: "rt", account_id: "acct" },
      last_refresh: "2026-01-02T03:04:05.000Z",
    });
  });
});

describe("resolveCodexAuth", () => {
  it("materializes auth.json (0600) for a forwarded ChatGPT credential", () => {
    const home = scratch();
    const auth = resolveCodexAuth({
      [CODEX_HOME_OVERRIDE_ENV]: path.join(home, "codex"),
      CODEX_ACCESS_TOKEN: "at",
      [CODEX_ID_TOKEN_ENV]: "it",
      [CODEX_REFRESH_TOKEN_ENV]: "rt",
      [CODEX_ACCOUNT_ID_ENV]: "acct",
    });
    expect(auth.mode).toBe("chatgpt");
    const file = path.join(auth.codexHome, "auth.json");
    expect(JSON.parse(readFileSync(file, "utf8")).tokens).toMatchObject({
      access_token: "at",
      refresh_token: "rt",
      account_id: "acct",
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an operator-managed auth.json under their own CODEX_HOME", () => {
    const home = scratch();
    writeFileSync(path.join(home, "auth.json"), '{"mine":true}\n');
    const auth = resolveCodexAuth({
      [CODEX_HOME_OVERRIDE_ENV]: home,
      CODEX_ACCESS_TOKEN: "at",
    });
    expect(auth.codexHome).toBe(home);
    expect(readFileSync(path.join(home, "auth.json"), "utf8")).toBe('{"mine":true}\n');
  });

  it("creates the home but writes no credential in api-key mode", () => {
    const home = path.join(scratch(), "codex");
    const auth = resolveCodexAuth({
      [CODEX_HOME_OVERRIDE_ENV]: home,
      OPENAI_API_KEY: "sk-x",
    });
    expect(auth.mode).toBe("api-key");
    expect(existsSync(home)).toBe(true);
    expect(existsSync(path.join(home, "auth.json"))).toBe(false);
  });

  it("touches nothing at all in ambient mode", () => {
    const home = path.join(scratch(), "absent");
    const auth = resolveCodexAuth({ CODEX_HOME: home, HOME: "/home/u" });
    expect(auth).toEqual({ mode: "ambient", codexHome: home });
    expect(existsSync(home)).toBe(false);
  });
});
