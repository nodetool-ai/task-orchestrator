// __tests__/config.test.ts
//
// R6: the typed config module. Locks the truthiness convention and the derived
// values (remote providers force detached; isolate default remotely; INSIDE_WORKER truthiness
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
} from "../lib/config";

// Every var these tests touch, restored after each case.
const KEYS = [
  "TASK_ORCH_RUNNER",
  "TASK_ORCH_DETACHED_RUNS",
  "TASK_ORCH_INSIDE_WORKER",
  "TASK_ORCH_NESTED_DISPATCH",
  "TASK_ORCH_ADMISSION_ENABLED",
  "TASK_ORCH_WORKER_IMAGE",
  "TASK_ORCH_GIT_CLONE_DEPTH",
  "TASK_ORCH_MAX_RUN_DEPTH",
  "TASK_ORCH_MAX_TREE_RUNS",
  "TASK_ORCH_TREE_BUDGET_MULT",
  "TASK_ORCH_PENDING_PUMP_MS",
  "TASK_ORCH_MAX_DEFER_MS",
  "TASK_ORCH_CHAT_IDLE_MS",
  "TASK_ORCH_CHAT_MAX_TOOL_ROUNDS",
  "TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS",
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

  it("default-on reproduces the ADMISSION_ENABLED parser (absent ⇒ on)", () => {
    // old: v == null || (v !== "0" && v.toLowerCase() !== "false")
    const old = (v: string | undefined) => v == null || (v !== "0" && v.toLowerCase() !== "false");
    for (const v of [undefined, "", "0", "false", "FALSE", "1", "true"]) {
      set("TASK_ORCH_ADMISSION_ENABLED", v);
      expect(flag("TASK_ORCH_ADMISSION_ENABLED", true)).toBe(old(v));
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
    set("TASK_ORCH_RUNNER", "sprites");
    expect(runnerProviderKind()).toBe("sprites");
    for (const v of [undefined, "", "local", "docker", "box", "FLY", "1", "true"]) {
      set("TASK_ORCH_RUNNER", v);
      expect(runnerProviderKind()).toBe("local");
    }
  });
});

describe("detachedRunsEnabled() — remote providers force detached", () => {
  it("sprites is detached even with the flag unset or explicitly off", () => {
    set("TASK_ORCH_RUNNER", "sprites");
    for (const v of [undefined, "0", "false"]) {
      set("TASK_ORCH_DETACHED_RUNS", v);
      expect(detachedRunsEnabled()).toBe(true);
    }
  });

  it("locally it is the plain flag", () => {
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
  it("defaults to isolate on sprites, inline locally", () => {
    set("TASK_ORCH_NESTED_DISPATCH", undefined);
    set("TASK_ORCH_RUNNER", "sprites");
    expect(nestedDispatchMode()).toBe("isolate");
    set("TASK_ORCH_RUNNER", "local");
    expect(nestedDispatchMode()).toBe("inline");
  });

  it("explicit value wins over the provider default (case-insensitive)", () => {
    set("TASK_ORCH_RUNNER", "sprites"); // default would be isolate
    set("TASK_ORCH_NESTED_DISPATCH", "INLINE");
    expect(nestedDispatchMode()).toBe("inline");
    set("TASK_ORCH_RUNNER", "local"); // default would be inline
    set("TASK_ORCH_NESTED_DISPATCH", "Isolate");
    expect(nestedDispatchMode()).toBe("isolate");
  });

  it("an unrecognized explicit value falls through to the default", () => {
    set("TASK_ORCH_RUNNER", "sprites");
    set("TASK_ORCH_NESTED_DISPATCH", "garbage");
    expect(nestedDispatchMode()).toBe("isolate");
  });
});

describe("lazy reads — a mid-process env flip takes effect", () => {
  it("config accessors reflect the current env, not an import-time snapshot", () => {
    set("TASK_ORCH_RUNNER", "local");
    expect(config.deployment.runnerKind).toBe("local");
    set("TASK_ORCH_RUNNER", "sprites");
    expect(config.deployment.runnerKind).toBe("sprites");
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
          key === "TASK_ORCH_EXECUTOR_MAX_TOOL_ROUNDS") set(key, undefined);
    }
    expect(config.dispatch.maxRunDepth).toBe(3);
    expect(config.dispatch.maxTreeRuns).toBe(32);
    expect(config.dispatch.treeBudgetMult).toBe(3);
    expect(config.dispatch.pendingPumpMs).toBe(15_000);
    expect(config.dispatch.maxDeferMs).toBe(30 * 60_000);
    expect(config.agent.chatIdleMs).toBe(600_000);
    expect(config.agent.chatMaxToolRounds).toBe(64);
    expect(config.agent.executorMaxToolRounds).toBe(30);
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

describe("deployment.gitCloneDepth — shallow in-runner clone depth", () => {
  it("defaults to a depth-1 shallow clone", () => {
    set("TASK_ORCH_GIT_CLONE_DEPTH", undefined);
    expect(config.deployment.gitCloneDepth).toBe(1);
  });

  it("honours an explicit deeper limit", () => {
    set("TASK_ORCH_GIT_CLONE_DEPTH", "50");
    expect(config.deployment.gitCloneDepth).toBe(50);
  });

  it("treats 0 as an opt-out (full-history clone)", () => {
    set("TASK_ORCH_GIT_CLONE_DEPTH", "0");
    expect(config.deployment.gitCloneDepth).toBe(0);
  });
});

describe("snapshot() — frozen plain-value dump", () => {
  it("captures derived values and is frozen", () => {
    set("TASK_ORCH_RUNNER", "sprites");
    set("TASK_ORCH_DETACHED_RUNS", "0");
    const snap = snapshot();
    expect(snap.derived.runnerProviderKind).toBe("sprites");
    expect(snap.derived.detachedRunsEnabled).toBe(true); // remote provider forces it
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.derived)).toBe(true);
  });
});
