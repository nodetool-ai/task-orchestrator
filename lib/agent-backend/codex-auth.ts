// lib/agent-backend/codex-auth.ts
//
// How a Codex-backed run authenticates, and which CODEX_HOME it uses.
//
// The Codex CLI resolves credentials one of two ways:
//   - API key — OPENAI_API_KEY / CODEX_API_KEY in its environment.
//   - ChatGPT — an OAuth token set in `$CODEX_HOME/auth.json`, normally written
//               by `codex login`.
//
// This deployment already owns a ChatGPT credential: Settings → Codex stores it
// in `codex_credentials` (lib/codex-oauth-store.ts) so it survives a redeploy,
// and lib/agent-backend/provider-env.ts forwards it to workers as env. Workers
// have no DB and no `codex login`, so for the ChatGPT path this module
// materializes the same auth.json the CLI would have written. One ChatGPT
// subscription then serves both pi's `openai-codex` provider and this backend —
// the mirror image of what applyClaudeCodeAnthropicFallback does for the
// claude.ai subscription.
//
// CODEX_HOME is *not* a temp dir: `resumeThread()` reads the thread transcript
// from `$CODEX_HOME/sessions`, so a per-turn directory would break multi-turn
// continuity. It is also not `~/.codex` by default — writing our auth.json there
// would clobber a developer's own `codex login`, and inheriting their
// config.toml would let an ambient MCP server (say, a "task-orchestrator" entry
// pointed at a *remote* deployment) capture this run's orchestrator writes. So
// runs get a dedicated home we own, unless an operator overrides it.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Env vars carrying the stored ChatGPT credential to a worker. CODEX_ACCESS_TOKEN
 *  predates this backend (pi's openai-codex provider reads it directly); the rest
 *  exist because the CLI's auth.json wants the whole token set. */
export const CODEX_ID_TOKEN_ENV = "CODEX_ID_TOKEN";
export const CODEX_REFRESH_TOKEN_ENV = "CODEX_REFRESH_TOKEN";
export const CODEX_ACCOUNT_ID_ENV = "CODEX_ACCOUNT_ID";

/** Explicit operator override for the CLI's home directory. */
export const CODEX_HOME_OVERRIDE_ENV = "TASK_ORCH_CODEX_HOME";

export type CodexAuthMode = "api-key" | "chatgpt" | "ambient";

export interface CodexAuth {
  mode: CodexAuthMode;
  /** CODEX_HOME handed to the CLI. */
  codexHome: string;
}

type EnvLike = Record<string, string | undefined>;

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() ? v : undefined;
}

/**
 * The auth.json the Codex CLI writes for a ChatGPT login. Pure, so the shape is
 * unit-testable without touching a filesystem.
 */
export function chatGptAuthJson(tokens: {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  accountId?: string;
  now?: Date;
}): string {
  return (
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: tokens.idToken ?? "",
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken ?? "",
          account_id: tokens.accountId ?? null,
        },
        last_refresh: (tokens.now ?? new Date()).toISOString(),
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Which credential the CLI will use, decided from the environment alone. An
 * explicit API key wins (it is the unambiguous signal an operator configured
 * one); otherwise a forwarded ChatGPT token; otherwise whatever the machine
 * already has. Exported for tests — the backend calls `resolveCodexAuth`.
 */
export function codexAuthMode(env: EnvLike): CodexAuthMode {
  if (nonEmpty(env.CODEX_API_KEY) || nonEmpty(env.OPENAI_API_KEY)) return "api-key";
  if (nonEmpty(env.CODEX_ACCESS_TOKEN)) return "chatgpt";
  return "ambient";
}

/**
 * The CODEX_HOME a run should use for `mode`. Pure — `resolveCodexAuth` is what
 * creates it and writes into it.
 */
export function codexHomeFor(mode: CodexAuthMode, env: EnvLike): string {
  const override = nonEmpty(env[CODEX_HOME_OVERRIDE_ENV]);
  if (override) return override;
  // Nothing of ours to install: defer to the machine's own Codex setup so a dev
  // box where someone ran `codex login` works with no extra configuration.
  if (mode === "ambient") return nonEmpty(env.CODEX_HOME) ?? path.join(home(env), ".codex");
  return path.join(home(env), ".task-orchestrator", "codex");
}

function home(env: EnvLike): string {
  return nonEmpty(env.HOME) ?? safeHomedir();
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return tmpdir();
  }
}

/**
 * Resolve auth for one turn: pick the mode, make sure CODEX_HOME exists, and in
 * ChatGPT mode (re)write auth.json so a token refreshed by the control plane
 * reaches the CLI. Never writes into a home we don't own — see the module note.
 */
export function resolveCodexAuth(env: EnvLike = process.env): CodexAuth {
  const mode = codexAuthMode(env);
  const codexHome = codexHomeFor(mode, env);

  if (mode === "ambient") return { mode, codexHome };

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  if (mode === "chatgpt") {
    const authPath = path.join(codexHome, "auth.json");
    const override = nonEmpty(env[CODEX_HOME_OVERRIDE_ENV]);
    // Under an operator-chosen home, an existing auth.json may be their own
    // `codex login`; don't overwrite it with a forwarded token.
    if (override && existsSync(authPath)) return { mode, codexHome };
    writeFileSync(
      authPath,
      chatGptAuthJson({
        accessToken: env.CODEX_ACCESS_TOKEN as string,
        idToken: nonEmpty(env[CODEX_ID_TOKEN_ENV]),
        refreshToken: nonEmpty(env[CODEX_REFRESH_TOKEN_ENV]),
        accountId: nonEmpty(env[CODEX_ACCOUNT_ID_ENV]),
      }),
      { mode: 0o600 }
    );
  }

  return { mode, codexHome };
}
