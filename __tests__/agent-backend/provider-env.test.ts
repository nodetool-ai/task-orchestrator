// Container env forwarding for the agent backends: both worker paths (Docker
// containers and Fly Machines) must hand the worker every credential the
// server holds, for the claude AND pi backends alike — a container dispatched
// with TASK_ORCH_AGENT_BACKEND=pi boots fine and then fails its first provider
// call if only the Anthropic pair was forwarded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviders, findEnvKeys } from "@earendil-works/pi-ai";
import {
  AGENT_CREDENTIAL_ENV_KEYS,
  agentCredentialEnv,
} from "../../lib/agent-backend/provider-env";
import { buildFlyWorkerEnv } from "../../lib/runner/fly";
import { buildWorkerContainerConfig } from "../../lib/run-dispatch";

// GH_TOKEN doubles as a pi github-copilot credential but is forwarded
// separately (and unconditionally) by both worker paths for git/gh itself.
const FORWARDED_ELSEWHERE = ["GH_TOKEN"];

// Providers that don't authenticate via a plain env API key: amazon-bedrock
// uses the AWS SDK credential chain, openai-codex is OAuth-only. Deployments
// using them must configure credentials on the worker image/Machine directly.
const NO_ENV_KEY_PROVIDERS = new Set(["amazon-bedrock", "openai-codex"]);

// Keys guaranteed absent from the ambient test env, one per assertion role.
const PI_KEY = "OPENROUTER_API_KEY";
const UNSET_KEY = "CEREBRAS_API_KEY";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AGENT_CREDENTIAL_ENV_KEYS", () => {
  it("covers every env-key provider pi-ai knows (sync guard for pi upgrades)", () => {
    // pi-ai's findEnvKeys only reports keys that are SET, so stub every key we
    // forward: a provider that still resolves no credential reads an env var
    // outside AGENT_CREDENTIAL_ENV_KEYS and containers would be starved of it.
    for (const key of [...AGENT_CREDENTIAL_ENV_KEYS, ...FORWARDED_ELSEWHERE]) {
      vi.stubEnv(key, "test-value");
    }
    const uncovered = getProviders().filter(
      (p) => !NO_ENV_KEY_PROVIDERS.has(p) && !findEnvKeys(p)?.length
    );
    expect(
      uncovered,
      "these pi providers read a credential env var missing from AGENT_CREDENTIAL_ENV_KEYS (lib/agent-backend/provider-env.ts)"
    ).toEqual([]);
  });

  it("agentCredentialEnv returns only the keys actually set", () => {
    vi.stubEnv(PI_KEY, "sk-or-test");
    delete process.env[UNSET_KEY];
    const env = agentCredentialEnv();
    expect(env[PI_KEY]).toBe("sk-or-test");
    expect(UNSET_KEY in env).toBe(false);
  });
});

describe("worker env builders forward pi provider credentials", () => {
  it("buildFlyWorkerEnv includes a set pi key and omits unset ones", () => {
    vi.stubEnv(PI_KEY, "sk-or-test");
    delete process.env[UNSET_KEY];
    const env = buildFlyWorkerEnv(42);
    expect(env[PI_KEY]).toBe("sk-or-test");
    expect(UNSET_KEY in env).toBe(false);
  });

  it("buildWorkerContainerConfig includes a set pi key and omits unset ones", () => {
    vi.stubEnv("TASK_ORCH_WORKER_IMAGE", "worker:test");
    vi.stubEnv(PI_KEY, "sk-or-test");
    delete process.env[UNSET_KEY];
    const cfg = buildWorkerContainerConfig(42, "run-42-x") as { Env: string[] };
    expect(cfg.Env).toContain(`${PI_KEY}=sk-or-test`);
    expect(cfg.Env.some((e) => e.startsWith(`${UNSET_KEY}=`))).toBe(false);
  });
});
