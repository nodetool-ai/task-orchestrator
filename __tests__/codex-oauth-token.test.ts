import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexAuthPath,
  resolveCodexAccessToken,
  resolveCodexAccessTokenSync,
} from "../lib/codex-oauth-token";

function tempCodexHome() {
  return mkdtempSync(join(tmpdir(), "task-orch-codex-token-"));
}

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${payload}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex OAuth token resolver", () => {
  it("prefers CODEX_ACCESS_TOKEN over the auth file", async () => {
    const dir = tempCodexHome();
    try {
      const env = { CODEX_HOME: dir, CODEX_ACCESS_TOKEN: "from-env" };
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "from-file" } }));

      expect(resolveCodexAccessTokenSync(env)).toBe("from-env");
      await expect(resolveCodexAccessToken(env)).resolves.toBe("from-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the access token from CODEX_HOME/auth.json", () => {
    const dir = tempCodexHome();
    try {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "from-file" } }));

      expect(codexAuthPath({ CODEX_HOME: dir })).toBe(join(dir, "auth.json"));
      expect(resolveCodexAccessTokenSync({ CODEX_HOME: dir })).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired file token and writes the rotated token back", async () => {
    const dir = tempCodexHome();
    const expired = fakeJwt(Math.floor(Date.now() / 1000) - 60);
    try {
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({ tokens: { access_token: expired, refresh_token: "refresh-token" } })
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ access_token: "new-access-token", refresh_token: "new-refresh-token" }),
        }))
      );

      await expect(resolveCodexAccessToken({ CODEX_HOME: dir })).resolves.toBe("new-access-token");
      const updated = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
      expect(updated.tokens.access_token).toBe("new-access-token");
      expect(updated.tokens.refresh_token).toBe("new-refresh-token");
      expect(updated.last_refresh).toEqual(expect.any(String));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
