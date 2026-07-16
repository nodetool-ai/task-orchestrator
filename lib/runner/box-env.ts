// Explicit, allowlisted environment for a Box worker.  A Box fork must use
// this together with `noEnv: true`; inherited Box-account environment is never
// safe to hand to a tenant run.

import { AGENT_CREDENTIAL_ENV_KEYS, agentCredentialEnv } from "../agent-backend/provider-env";
import { config, nestedDispatchMode, type NestedDispatchMode } from "../config";

/** Limits documented by the Box fork API. */
export const BOX_ENV_MAX_VARIABLES = 100;
export const BOX_ENV_MAX_BYTES = 64 * 1024;

const DEFAULT_SESSION_ROOT = "/home/user/.task-orchestrator/session";
const REDACTED = "[redacted]";

export type BoxWorkerEnvInput = {
  /** The run this Box is exclusively assigned to. */
  runId: number;
  /** The control-plane repository id, for diagnostics and worker context. */
  repoId: string;
  /** Overrides deployment config in tests or for an explicitly named instance. */
  instanceId?: string;
  /** Overrides the configured template version when the caller has resolved it. */
  templateVersion?: string;
  /** A template-specific, absolute checkout path. */
  repoPath?: string;
  /** Session state that must survive Box stop/resume snapshots. */
  sessionRoot?: string;
  /** Resolved by the control plane before a worker loses TASK_ORCH_RUNNER. */
  nestedDispatch?: NestedDispatchMode;
};

function requiredString(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Cannot build Box worker environment: ${label} is required`);
  return value;
}

function setIfPresent(env: Record<string, string>, key: string, value: string | undefined): void {
  if (value != null) env[key] = value;
}

/**
 * Reject an environment that the Box API would reject.  Count UTF-8 bytes for
 * the actual `KEY=value` entries, which is both deterministic in tests and
 * conservative for non-ASCII credential values.
 */
export function validateBoxWorkerEnv(env: Readonly<Record<string, string>>): void {
  const entries = Object.entries(env);
  if (entries.length > BOX_ENV_MAX_VARIABLES) {
    throw new Error(
      `Box worker environment has ${entries.length} variables; Box permits at most ${BOX_ENV_MAX_VARIABLES}`
    );
  }

  const bytes = entries.reduce((total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`, "utf8"), 0);
  if (bytes > BOX_ENV_MAX_BYTES) {
    throw new Error(
      `Box worker environment is ${bytes} bytes; Box permits at most ${BOX_ENV_MAX_BYTES} bytes`
    );
  }
}

/**
 * Build exactly the values a single worker needs.  This deliberately selects
 * each worker-protocol, identity, and credential value one-by-one rather than
 * inheriting process.env: in particular the Box control-plane API key and
 * DATABASE_URL cannot cross the control-plane boundary.
 */
export function buildBoxWorkerEnv(input: BoxWorkerEnvInput): Record<string, string> {
  const repoPath = requiredString(input.repoPath ?? config.box.repoPath, "TASK_ORCH_BOX_REPO_PATH");
  const repoId = requiredString(input.repoId, "repoId");
  const instanceId = input.instanceId ?? config.deployment.instanceId ?? "default";
  const templateVersion = input.templateVersion ?? config.box.templateVersion ?? "unknown";

  // This is intentionally an allowlist. Do not replace it with a process.env
  // spread: Box templates may have account credentials or dashboard secrets.
  const env: Record<string, string> = {
    TASK_ORCH_INSIDE_WORKER: "1",
    TASK_ORCH_RUN_ID: String(input.runId),
    TASK_ORCH_REPO_ID: repoId,
    TASK_ORCH_INSTANCE_ID: instanceId,
    TASK_ORCH_TEMPLATE_VERSION: templateVersion,
    TASK_ORCH_NESTED_DISPATCH: input.nestedDispatch ?? nestedDispatchMode(),
    TASK_ORCH_RUNNER_REPO_PATH: repoPath,
    SESSION_ROOT: input.sessionRoot ?? DEFAULT_SESSION_ROOT,
  };

  // Keep the allowlist coupled to the credential registry.  Iterating the
  // declared keys (instead of spreading agentCredentialEnv()) prevents a
  // future helper addition from silently widening the Box environment.
  const credentials = agentCredentialEnv();
  for (const key of AGENT_CREDENTIAL_ENV_KEYS) setIfPresent(env, key, credentials[key]);
  setIfPresent(env, "GH_TOKEN", process.env.GH_TOKEN);

  // Defense in depth: these are never added above, and this makes accidental
  // future additions fail closed rather than leak a control-plane secret.
  delete env.BOX_API_KEY;
  delete env.DATABASE_URL;

  validateBoxWorkerEnv(env);
  return env;
}

/** True when a value should never be emitted in a test/log snapshot. */
export function isSensitiveBoxWorkerEnvKey(key: string): boolean {
  return (
    key === "TASK_ORCH_WORKER_TOKEN" ||
    key === "GH_TOKEN" ||
    (AGENT_CREDENTIAL_ENV_KEYS as readonly string[]).includes(key) ||
    /(?:API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|AUTHORIZATION)/i.test(key)
  );
}

/**
 * A deterministic, safe representation for tests and structured diagnostics.
 * It is deliberately a new object, so callers cannot accidentally redact the
 * live environment they are about to pass to the Box API.
 */
export function redactBoxWorkerEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, isSensitiveBoxWorkerEnvKey(key) ? REDACTED : value])
    )
  );
}
