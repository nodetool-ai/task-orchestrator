// lib/agent-backend/provider-env.ts
//
// The credential env vars the agent backends read, shared by every path that
// hands env to an out-of-process worker (Docker worker containers and Fly
// runner Machines). Workers run the agent turn in-process via getBackend(), so
// whichever credentials the server holds must be forwarded — otherwise a
// container dispatched with TASK_ORCH_AGENT_BACKEND=pi boots fine and then
// fails its first provider call for want of a key that only the server had.
//
// The pi entries mirror @earendil-works/pi-ai's env-api-keys map (AuthStorage
// falls back to these when ~/.pi/agent/auth.json has no entry for a provider).
// A unit test (__tests__/agent-backend/provider-env.test.ts) asserts this list
// covers every provider key pi-ai knows, so a pi upgrade that adds a provider
// fails the suite instead of silently starving containers of the new key.
export const AGENT_CREDENTIAL_ENV_KEYS: readonly string[] = [
  // Claude backend (resolved like the Claude Code CLI) + pi's anthropic provider.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // pi multi-provider API keys.
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "ANT_LING_API_KEY",
  "NVIDIA_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  // pi's github-copilot provider (GH_TOKEN/GITHUB_TOKEN also qualify; GH_TOKEN
  // is forwarded separately by both worker paths for git/gh itself).
  "COPILOT_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  // Azure OpenAI needs its endpoint config alongside the key to be usable.
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  // Brave Search tool. BRAVE_API_KEY is accepted as a compatibility alias.
  "BRAVE_SEARCH_API_KEY",
  "BRAVE_API_KEY",
];

/** The subset of AGENT_CREDENTIAL_ENV_KEYS currently set (possibly to ""),
 *  as a { key: value } record — spread into a worker env map. */
export function agentCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of AGENT_CREDENTIAL_ENV_KEYS) {
    const value = process.env[key];
    if (value != null) env[key] = value;
  }
  return env;
}
