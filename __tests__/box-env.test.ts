import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BOX_ENV_MAX_BYTES,
  BOX_ENV_MAX_VARIABLES,
  buildBoxWorkerEnv,
  redactBoxWorkerEnv,
  validateBoxWorkerEnv,
} from "../lib/runner/box-env";

const KNOBS = [
  "TASK_ORCH_WORKER_API_URL",
  "TASK_ORCH_WORKER_API_SECRET",
  "TASK_ORCH_BOX_REPO_PATH",
  "TASK_ORCH_BOX_TEMPLATE_VERSION",
  "TASK_ORCH_INSTANCE_ID",
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_NESTED_DISPATCH",
  "BOX_API_KEY",
  "DATABASE_URL",
  "UNRELATED_CONTROL_PLANE_SECRET",
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of KNOBS) delete process.env[key];
});

function stubBaseEnv(): void {
  vi.stubEnv("TASK_ORCH_WORKER_API_URL", "https://orchestrator.example.test");
  vi.stubEnv("TASK_ORCH_WORKER_API_SECRET", "worker-signing-secret");
  vi.stubEnv("TASK_ORCH_BOX_REPO_PATH", "/home/user/repository");
  vi.stubEnv("TASK_ORCH_BOX_TEMPLATE_VERSION", "template-2026-07-14");
  vi.stubEnv("TASK_ORCH_INSTANCE_ID", "staging-a");
}

describe("buildBoxWorkerEnv", () => {
  it("uses an explicit allowlist and forwards only worker credentials", () => {
    stubBaseEnv();
    vi.stubEnv("BOX_API_KEY", "bx-control-plane-key");
    vi.stubEnv("DATABASE_URL", "postgres://must-not-leak");
    vi.stubEnv("UNRELATED_CONTROL_PLANE_SECRET", "must-not-leak");
    vi.stubEnv("GH_TOKEN", "ghp-run-token");
    vi.stubEnv("OPENAI_API_KEY", "sk-agent-key");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("TASK_ORCH_RUNNER", "box");

    const env = buildBoxWorkerEnv({ runId: 42, repoId: "repo_123" });

    expect(env).toMatchObject({
      TASK_ORCH_WORKER_API_URL: "https://orchestrator.example.test",
      TASK_ORCH_INSIDE_WORKER: "1",
      TASK_ORCH_RUN_ID: "42",
      TASK_ORCH_REPO_ID: "repo_123",
      TASK_ORCH_INSTANCE_ID: "staging-a",
      TASK_ORCH_TEMPLATE_VERSION: "template-2026-07-14",
      TASK_ORCH_NESTED_DISPATCH: "isolate",
      TASK_ORCH_RUNNER_REPO_PATH: "/home/user/repository",
      SESSION_ROOT: "/home/user/.task-orchestrator/session",
      GH_TOKEN: "ghp-run-token",
      OPENAI_API_KEY: "sk-agent-key",
      CEREBRAS_API_KEY: "",
    });
    expect(env.TASK_ORCH_WORKER_TOKEN).toMatch(/^wt1\.42\./);
    expect(env).not.toHaveProperty("BOX_API_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("UNRELATED_CONTROL_PLANE_SECRET");
  });

  it("uses caller-provided Box-local paths and resolved dispatch policy", () => {
    stubBaseEnv();

    const env = buildBoxWorkerEnv({
      runId: 7,
      repoId: "repo_7",
      repoPath: "/home/user/another-repository",
      sessionRoot: "/home/user/.task-orchestrator/runs/7",
      nestedDispatch: "inline",
      templateVersion: "resolved-template-version",
      instanceId: "worker-test",
    });

    expect(env).toMatchObject({
      TASK_ORCH_RUNNER_REPO_PATH: "/home/user/another-repository",
      SESSION_ROOT: "/home/user/.task-orchestrator/runs/7",
      TASK_ORCH_NESTED_DISPATCH: "inline",
      TASK_ORCH_TEMPLATE_VERSION: "resolved-template-version",
      TASK_ORCH_INSTANCE_ID: "worker-test",
    });
  });

  it("fails before a Box API request when a credential exceeds the byte limit", () => {
    stubBaseEnv();
    vi.stubEnv("GH_TOKEN", "x".repeat(BOX_ENV_MAX_BYTES));

    expect(() => buildBoxWorkerEnv({ runId: 7, repoId: "repo_7" })).toThrow(
      /Box worker environment is .* bytes; Box permits at most 65536 bytes/
    );
  });
});

describe("validateBoxWorkerEnv", () => {
  it("rejects more than 100 variables", () => {
    const env = Object.fromEntries(
      Array.from({ length: BOX_ENV_MAX_VARIABLES + 1 }, (_, index) => [`VAR_${index}`, "x"])
    );

    expect(() => validateBoxWorkerEnv(env)).toThrow(/101 variables; Box permits at most 100/);
  });

  it("accepts the exact variable and byte limits", () => {
    const env = Object.fromEntries(
      Array.from({ length: BOX_ENV_MAX_VARIABLES }, (_, index) => [`V${index}`, ""])
    );
    expect(() => validateBoxWorkerEnv(env)).not.toThrow();
  });
});

describe("redactBoxWorkerEnv", () => {
  it("redacts worker and provider secrets without mutating the live environment", () => {
    const live = {
      TASK_ORCH_RUN_ID: "42",
      TASK_ORCH_WORKER_TOKEN: "wt1.42.secret",
      GH_TOKEN: "ghp-secret",
      OPENAI_API_KEY: "sk-secret",
      DATABASE_URL: "postgres://secret",
    };

    const snapshot = redactBoxWorkerEnv(live);
    expect(snapshot).toEqual({
      DATABASE_URL: "[redacted]",
      GH_TOKEN: "[redacted]",
      OPENAI_API_KEY: "[redacted]",
      TASK_ORCH_RUN_ID: "42",
      TASK_ORCH_WORKER_TOKEN: "[redacted]",
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(live.GH_TOKEN).toBe("ghp-secret");
  });
});
