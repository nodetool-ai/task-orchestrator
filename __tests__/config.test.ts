// __tests__/config.test.ts
//
// R6: the typed config module. Locks the truthiness convention and the derived
// values (fly forces detached; isolate default on fly; INSIDE_WORKER truthiness
// matches the ad-hoc parsers config replaced) so a future refactor can't drift.
import { afterEach, describe, expect, it } from "vitest";
import {
  config,
  detachedRunsEnabled,
  flag,
  insideWorker,
  nestedDispatchMode,
  runnerProviderKind,
  snapshot,
  truthy,
  validateBoxConfig,
} from "../lib/config";

// Every var these tests touch, restored after each case.
const KEYS = [
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_DETACHED_RUNS",
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_NESTED_DISPATCH",
  "TASK_ORCH_LIGHTWEIGHT_CHATS",
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_MAX_MACHINES",
  "TASK_ORCH_MAX_RUN_DEPTH",
  "TASK_ORCH_MAX_TREE_RUNS",
  "TASK_ORCH_TREE_BUDGET_MULT",
  "TASK_ORCH_PENDING_PUMP_MS",
  "TASK_ORCH_MAX_DEFER_MS",
  "TASK_ORCH_CHAT_IDLE_MS",
  "TASK_ORCH_CHAT_MAX_TOOL_ROUNDS",
  "TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS",
  "TASK_ORCH_FLY_CPUS",
  "TASK_ORCH_FLY_MEMORY_MB",
  "TASK_ORCH_FLY_POLL_MS",
  "TASK_ORCH_RUNNER_VOLUME_GB",
  "BOX_API_KEY",
  "TASK_ORCH_BOX_BASE_URL",
  "TASK_ORCH_BOX_TEMPLATE_ID",
  "TASK_ORCH_BOX_TEMPLATE_VERSION",
  "TASK_ORCH_BOX_REPO_PATH",
  "TASK_ORCH_BOX_IDLE_STOP_MS",
  "TASK_ORCH_BOX_POLL_MS",
  "TASK_ORCH_BOX_READY_TIMEOUT_MS",
  "TASK_ORCH_BOX_RETENTION_MS",
  "TASK_ORCH_BOX_MAX_ACTIVE",
  "TASK_ORCH_WORKER_API_URL",
  "TASK_ORCH_WORKER_API_SECRET",
  "TASK_ORCH_WORKER_TRANSPORT",
  "AUTH_SECRET",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});
function set(k: string, v: string | undefined) {
  if (v == null) delete process.env[k];
  else process.env[k] = v;
}

// The exact predicate config replaced, re-derived here so equivalence is
// checked against the original bytes, not a paraphrase.
const oldTruthy = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";

describe("truthy() — the default-off flag convention", () => {
  it("matches the pre-R6 ad-hoc parser for every shape", () => {
    for (const v of [undefined, "", "0", "false", "False", "FALSE", "1", "true", "yes", "x"]) {
      expect(truthy(v)).toBe(oldTruthy(v));
    }
  });
});

describe("flag() — default-on vs default-off", () => {
  it("default-off is plain truthy()", () => {
    set("TASK_ORCH_INSIDE_WORKER", undefined);
    expect(flag("TASK_ORCH_INSIDE_WORKER", false)).toBe(false);
    set("TASK_ORCH_INSIDE_WORKER", "1");
    expect(flag("TASK_ORCH_INSIDE_WORKER", false)).toBe(true);
    set("TASK_ORCH_INSIDE_WORKER", "0");
    expect(flag("TASK_ORCH_INSIDE_WORKER", false)).toBe(false);
  });

  it("default-on reproduces the LIGHTWEIGHT_CHATS parser (absent ⇒ on)", () => {
    // old: v == null || (v !== "0" && v.toLowerCase() !== "false")
    const old = (v: string | undefined) => v == null || (v !== "0" && v.toLowerCase() !== "false");
    for (const v of [undefined, "", "0", "false", "FALSE", "1", "true"]) {
      set("TASK_ORCH_LIGHTWEIGHT_CHATS", v);
      expect(flag("TASK_ORCH_LIGHTWEIGHT_CHATS", true)).toBe(old(v));
    }
  });
});

describe("insideWorker() truthiness matches the old parsers", () => {
  it("agrees with the pre-R6 predicate for every shape", () => {
    for (const v of [undefined, "", "0", "false", "False", "1", "true", "x"]) {
      set("TASK_ORCH_INSIDE_WORKER", v);
      expect(insideWorker()).toBe(oldTruthy(v));
      expect(config.worker.inside).toBe(oldTruthy(v));
    }
  });
});

describe("runnerProviderKind() — exact provider equality, not truthiness", () => {
  it("only supported provider literals select remote providers", () => {
    set("TASK_ORCH_RUNNER", "fly");
    expect(runnerProviderKind()).toBe("fly");
    set("TASK_ORCH_RUNNER", "box");
    expect(runnerProviderKind()).toBe("box");
    for (const v of [undefined, "", "local", "docker", "FLY", "BOX", "1", "true"]) {
      set("TASK_ORCH_RUNNER", v);
      expect(runnerProviderKind()).toBe("local");
    }
  });
});

describe("detachedRunsEnabled() — fly FORCES detached", () => {
  it("fly is detached even with the flag unset or explicitly off", () => {
    set("TASK_ORCH_RUNNER", "fly");
    for (const v of [undefined, "0", "false"]) {
      set("TASK_ORCH_DETACHED_RUNS", v);
      expect(detachedRunsEnabled()).toBe(true);
    }
  });

  it("box is detached even with the flag unset or explicitly off", () => {
    set("TASK_ORCH_RUNNER", "box");
    for (const v of [undefined, "0", "false"]) {
      set("TASK_ORCH_DETACHED_RUNS", v);
      expect(detachedRunsEnabled()).toBe(true);
    }
  });

  it("off fly it is the plain flag", () => {
    set("TASK_ORCH_RUNNER", "local");
    set("TASK_ORCH_DETACHED_RUNS", undefined);
    expect(detachedRunsEnabled()).toBe(false);
    set("TASK_ORCH_DETACHED_RUNS", "1");
    expect(detachedRunsEnabled()).toBe(true);
    set("TASK_ORCH_DETACHED_RUNS", "false");
    expect(detachedRunsEnabled()).toBe(false);
  });
});

describe("nestedDispatchMode() — isolate default on managed remote providers", () => {
  it("defaults to isolate on fly or box, inline locally", () => {
    set("TASK_ORCH_NESTED_DISPATCH", undefined);
    set("TASK_ORCH_RUNNER", "fly");
    expect(nestedDispatchMode()).toBe("isolate");
    set("TASK_ORCH_RUNNER", "box");
    expect(nestedDispatchMode()).toBe("isolate");
    set("TASK_ORCH_RUNNER", "local");
    expect(nestedDispatchMode()).toBe("inline");
  });

  it("explicit value wins over the provider default (case-insensitive)", () => {
    set("TASK_ORCH_RUNNER", "fly"); // default would be isolate
    set("TASK_ORCH_NESTED_DISPATCH", "INLINE");
    expect(nestedDispatchMode()).toBe("inline");
    set("TASK_ORCH_RUNNER", "local"); // default would be inline
    set("TASK_ORCH_NESTED_DISPATCH", "Isolate");
    expect(nestedDispatchMode()).toBe("isolate");
  });

  it("an unrecognized explicit value falls through to the default", () => {
    set("TASK_ORCH_RUNNER", "fly");
    set("TASK_ORCH_NESTED_DISPATCH", "garbage");
    expect(nestedDispatchMode()).toBe("isolate");
  });
});

describe("lazy reads — a mid-process env flip takes effect", () => {
  it("config accessors reflect the current env, not an import-time snapshot", () => {
    set("TASK_ORCH_RUNNER", "local");
    expect(config.deployment.runnerKind).toBe("local");
    set("TASK_ORCH_RUNNER", "fly");
    expect(config.deployment.runnerKind).toBe("fly");
  });
});

describe("documented numeric defaults", () => {
  it("matches the defaults used by the runtime consumers", () => {
    for (const key of KEYS) {
      if (key.startsWith("TASK_ORCH_MAX_RUN_") ||
          key === "TASK_ORCH_MAX_TREE_RUNS" ||
          key === "TASK_ORCH_TREE_BUDGET_MULT" ||
          key === "TASK_ORCH_PENDING_PUMP_MS" ||
          key === "TASK_ORCH_MAX_DEFER_MS" ||
          key === "TASK_ORCH_CHAT_IDLE_MS" ||
          key === "TASK_ORCH_CHAT_MAX_TOOL_ROUNDS" ||
          key === "TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS" ||
          key.startsWith("TASK_ORCH_FLY_") ||
          key === "TASK_ORCH_RUNNER_VOLUME_GB") set(key, undefined);
    }
    expect(config.dispatch.maxRunDepth).toBe(3);
    expect(config.dispatch.maxTreeRuns).toBe(32);
    expect(config.dispatch.treeBudgetMult).toBe(3);
    expect(config.dispatch.pendingPumpMs).toBe(15_000);
    expect(config.dispatch.maxDeferMs).toBe(30 * 60_000);
    expect(config.agent.chatIdleMs).toBe(600_000);
    expect(config.agent.chatMaxToolRounds).toBe(64);
    expect(config.agent.executorMaxToolRounds).toBe(30);
    expect(config.fly.cpus).toBe(4);
    expect(config.fly.memoryMb).toBe(4096);
    expect(config.fly.pollMs).toBe(10_000);
    expect(config.fly.volumeGb).toBe(10);
  });

  it("keeps positive-only defaults when configured as zero", () => {
    set("TASK_ORCH_CHAT_IDLE_MS", "0");
    set("TASK_ORCH_CHAT_MAX_TOOL_ROUNDS", "0");
    set("TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS", "-1");
    set("TASK_ORCH_TREE_BUDGET_MULT", "0");
    expect(config.agent.chatIdleMs).toBe(600_000);
    expect(config.agent.chatMaxToolRounds).toBe(64);
    expect(config.agent.executorMaxToolRounds).toBe(30);
    expect(config.dispatch.treeBudgetMult).toBe(3);
  });
});

describe("snapshot() — frozen plain-value dump", () => {
  it("captures derived values and is frozen", () => {
    set("TASK_ORCH_RUNNER", "fly");
    set("TASK_ORCH_DETACHED_RUNS", "0");
    const snap = snapshot();
    expect(snap.derived.runnerProviderKind).toBe("fly");
    expect(snap.derived.detachedRunsEnabled).toBe(true); // fly forces it
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.derived)).toBe(true);
  });
});

describe("Box configuration", () => {
  function selectBoxWithRequiredValues() {
    set("TASK_ORCH_RUNNER", "box");
    set("BOX_API_KEY", "box-api-key-secret");
    set("TASK_ORCH_BOX_TEMPLATE_ID", "bx_template_123");
    set("TASK_ORCH_WORKER_API_URL", "https://orchestrator.example.test");
    set("TASK_ORCH_WORKER_API_SECRET", "worker-signing-secret");
  }

  it("is inert when Box is not selected", () => {
    set("TASK_ORCH_RUNNER", "local");
    expect(() => validateBoxConfig()).not.toThrow();
  });

  it("rejects the WebSocket transport with the unsupported-provider message", () => {
    selectBoxWithRequiredValues();
    set("TASK_ORCH_WORKER_TRANSPORT", "ws");
    expect(() => validateBoxConfig()).toThrow(
      /Box runners do not yet expose a private control-plane-to-worker WebSocket endpoint\./
    );
  });

  it("reads Box settings lazily with the documented defaults", () => {
    expect(config.box.baseUrl).toBe("https://ascii.dev/api/box/v1");
    expect(config.box.idleStopMs).toBe(30_000);
    expect(config.box.pollMs).toBe(5_000);
    expect(config.box.readyTimeoutMs).toBe(120_000);
    expect(config.box.retentionMs).toBe(30 * 24 * 60 * 60_000);
    expect(config.box.maxActive).toBe(0);

    set("TASK_ORCH_BOX_REPO_PATH", "/home/user/repository");
    expect(config.box.repoPath).toBe("/home/user/repository");
    set("TASK_ORCH_BOX_REPO_PATH", "/home/user/other-repository");
    expect(config.box.repoPath).toBe("/home/user/other-repository");
  });

  it("reports every required value with actionable names when Box is selected", () => {
    set("TASK_ORCH_RUNNER", "box");
    set("TASK_ORCH_WORKER_API_URL", undefined);
    set("TASK_ORCH_WORKER_API_SECRET", undefined);
    set("AUTH_SECRET", undefined);
    expect(() => validateBoxConfig()).toThrow(/BOX_API_KEY/);
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_BOX_TEMPLATE_ID/);
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_WORKER_API_URL/);
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_WORKER_API_SECRET or AUTH_SECRET/);
  });

  it("validates Box identifiers and non-negative integer settings", () => {
    selectBoxWithRequiredValues();
    set("TASK_ORCH_BOX_TEMPLATE_ID", "not-a-box-id");
    set("TASK_ORCH_BOX_POLL_MS", "-1");
    set("TASK_ORCH_BOX_MAX_ACTIVE", "1.5");
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_BOX_TEMPLATE_ID must be a Box ID/);
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_BOX_POLL_MS must be a non-negative integer/);
    expect(() => validateBoxConfig()).toThrow(/TASK_ORCH_BOX_MAX_ACTIVE must be a non-negative integer/);
  });

  it("accepts the existing AUTH_SECRET fallback for worker-token signing", () => {
    selectBoxWithRequiredValues();
    set("TASK_ORCH_WORKER_API_SECRET", undefined);
    set("AUTH_SECRET", "auth-secret");
    expect(() => validateBoxConfig()).not.toThrow();
  });

  it("redacts the Box API key from snapshots", () => {
    set("BOX_API_KEY", "box-api-key-secret");
    expect(snapshot().box.apiKey).toBe("[redacted]");
    expect(JSON.stringify(snapshot())).not.toContain("box-api-key-secret");
  });
});
