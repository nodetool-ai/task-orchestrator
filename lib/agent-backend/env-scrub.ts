// lib/agent-backend/env-scrub.ts
//
// Tier 0 secret scrubbing for agent tool subprocesses (incident: remote worker
// Machines run an AI agent that executes UNTRUSTED code — npm install,
// arbitrary bash inside cloned third-party repos — and those subprocesses
// currently inherit the whole worker process env, including DATABASE_URL
// (full prod DB access) and ~25 model-provider API keys/tokens. A malicious
// or compromised dependency's install script (or the agent itself, misled by
// a prompt injection in a cloned repo) can `printenv DATABASE_URL` and get
// full read/write access to the production database.
//
// This module is denylist-based, not allowlist-based: tool subprocesses
// legitimately need PATH/HOME/NODE_*/etc. to function, so we remove only the
// specific names known to carry secrets rather than trying to enumerate
// everything safe.

import { AGENT_CREDENTIAL_ENV_KEYS } from "./provider-env";
import {
  CODEX_ACCOUNT_ID_ENV,
  CODEX_ID_TOKEN_ENV,
  CODEX_REFRESH_TOKEN_ENV,
} from "./codex-auth";
import { CODEX_ACCESS_TOKEN_ENV } from "../codex-oauth-token";

// Names kept in bash/tool subprocess env despite being credential-shaped,
// because the git credential helper baked into the worker image
// (the worker image's git helper, `'!f() { echo username=x-access-token; echo
// "password=${GH_TOKEN}"; }; f'`) and the `gh` CLI both need them to do
// git push/pull/clone and API calls from agent-issued bash commands. This is
// a documented residual risk: untrusted bash can still read GH_TOKEN /
// GITHUB_TOKEN, which authorizes repo-scoped GitHub operations (not the DB
// or model-provider billing).
const KEEP_FOR_GIT = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

// Server-only secrets that never legitimately reach an agent tool
// subprocess. These aren't in AGENT_CREDENTIAL_ENV_KEYS (that list is model-
// provider credentials only) but must still be scrubbed:
//   - DATABASE_URL: full prod Postgres access — the incident trigger.
//   - FLY_API_TOKEN / SPRITES_TOKEN: control-plane infrastructure credentials
//     which must not reach a worker or its agent subprocesses.
//   - AUTH_SECRET / GITHUB_WEBHOOK_SECRET: irrelevant to remote workers (which
//     never hold them), but relevant when an agent run happens in-process on
//     the web server itself (TASK_ORCH_RUNNER unset/local) — there, bash
//     subprocesses would otherwise inherit the whole server process env,
//     including the session-signing secret and the webhook HMAC secret.
//   - TASK_ORCH_WORKER_CHANNEL_CREDENTIAL / _ENDPOINT / _INSTANCE_ID: the
//     websocket supervisor's authentication credential and listener metadata.
//     These are needed by the supervisor, but must not reach agent/model
//     subprocesses or any child process launched by agent code.
const SERVER_ONLY_SECRETS = [
  "DATABASE_URL",
  "FLY_API_TOKEN",
  "SPRITES_TOKEN",
  "AUTH_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "TASK_ORCH_WORKER_CHANNEL_CREDENTIAL",
  "TASK_ORCH_WORKER_CHANNEL_ENDPOINT",
  "TASK_ORCH_WORKER_INSTANCE_ID",
];

/**
 * Every env var name that must never reach an agent tool subprocess (bash,
 * and transitively anything bash spawns — npm install scripts, etc).
 *
 * Built from SERVER_ONLY_SECRETS plus every AGENT_CREDENTIAL_ENV_KEYS entry
 * except GH_TOKEN/GITHUB_TOKEN (kept — see KEEP_FOR_GIT above). Tool
 * subprocesses have no legitimate need for model-provider credentials: the
 * agent SDK/CLI process itself resolves those directly from its own env, not
 * by having bash re-read them.
 */
export const SECRET_ENV_DENYLIST: string[] = Array.from(
  new Set([
    ...SERVER_ONLY_SECRETS,
    ...AGENT_CREDENTIAL_ENV_KEYS.filter((k) => !KEEP_FOR_GIT.has(k)),
  ])
);

/** Return a copy of `env` with every SECRET_ENV_DENYLIST key removed. Denylist
 *  (not allowlist) scrub: tools legitimately need PATH/HOME/node/etc, so we
 *  only strip the specific names known to carry secrets. */
export function scrubEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of SECRET_ENV_DENYLIST) delete out[key];
  return out;
}

/**
 * A `unset A B C ...\n` shell prefix covering the full denylist, for
 * prepending to bash commands issued by either agent backend (see
 * lib/extensions/env-scrub.ts). Env var names are shell-safe bare
 * identifiers (`[A-Za-z_][A-Za-z0-9_]*`), so no quoting is needed. A single
 * `unset` invocation removes the vars from the shell's own environment, so
 * every child process the untrusted command subsequently spawns (npm
 * install scripts, git, etc.) inherits an environment without them too.
 */
export function bashUnsetPrefix(): string {
  return `unset ${SECRET_ENV_DENYLIST.join(" ")}\n`;
}

// Anthropic/Claude auth keys the Claude Code CLI itself resolves auth from
// (claude-backend.ts:164-169): ANTHROPIC_API_KEY when set, otherwise the
// claude.ai subscription via ANTHROPIC_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN.
// These must stay in the CLI's own process env even though everything else
// in SECRET_ENV_DENYLIST is stripped — the bash unset-prefix (still applied
// to the CLI's bash tool calls) strips them from bash children regardless,
// so the CLI keeps auth while its bash children don't.
const CLAUDE_CLI_AUTH_KEYS = new Set(
  AGENT_CREDENTIAL_ENV_KEYS.filter((k) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_"))
);

/**
 * Scrub the env handed to the Claude Code CLI subprocess (claude-backend.ts
 * `query({ options: { env } })`). The SDK's `env` REPLACES the subprocess
 * env entirely, so this must be applied to the fully-merged
 * `{ ...process.env, ...args.env }` (scrub AFTER the spread, so a caller-
 * supplied `args.env` entry is respected but still subject to the scrub).
 *
 * Removes SECRET_ENV_DENYLIST except the Anthropic/Claude auth keys the CLI
 * needs to authenticate itself.
 */
export function scrubClaudeCliEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of SECRET_ENV_DENYLIST) {
    if (CLAUDE_CLI_AUTH_KEYS.has(key)) continue;
    delete out[key];
  }
  return out;
}

// OpenAI/Codex auth keys the `codex` CLI resolves auth from (codex-auth.ts):
// an explicit API key, or the ChatGPT token set this deployment forwards from
// codex_credentials. Same bargain as CLAUDE_CLI_AUTH_KEYS — the CLI keeps its
// own credentials, and the Codex backend additionally keeps them out of the
// shell tool's environment via `shell_environment_policy.exclude`.
export const CODEX_CLI_AUTH_KEYS: readonly string[] = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  CODEX_ACCESS_TOKEN_ENV,
  CODEX_ID_TOKEN_ENV,
  CODEX_REFRESH_TOKEN_ENV,
  CODEX_ACCOUNT_ID_ENV,
];

const CODEX_CLI_AUTH_KEY_SET = new Set(CODEX_CLI_AUTH_KEYS);

/**
 * Scrub the env handed to the `codex` CLI subprocess (the Codex SDK's
 * `CodexOptions.env` REPLACES the child environment, so this must be applied to
 * the fully-merged `{ ...process.env, ...args.env }`).
 *
 * Removes SECRET_ENV_DENYLIST except the OpenAI/Codex auth keys the CLI needs
 * to authenticate itself.
 */
export function scrubCodexCliEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of SECRET_ENV_DENYLIST) {
    if (CODEX_CLI_AUTH_KEY_SET.has(key)) continue;
    delete out[key];
  }
  return out;
}
