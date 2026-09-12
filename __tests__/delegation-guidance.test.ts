// __tests__/delegation-guidance.test.ts
//
// A child run is a container, a checkout, a budget and a supervision chain; a
// native sub-agent is a call inside the run you already have. These tests pin
// the rule that says so — and, because the sub-agent half is harness-specific,
// that each run is told the tool its OWN backend actually has: Claude's `Agent`,
// Codex's `spawn_agent`, or (on pi, whose built-ins stop at read/write/edit/
// bash/grep/find/ls) that it has none and should do the sub-work inline rather
// than mint a run as a substitute.

import { describe, expect, it } from "vitest";
import {
  CHILD_RUN_ECONOMY_RULE,
  CLAUDE_SUBAGENT_GUIDANCE,
  CODEX_SUBAGENT_GUIDANCE,
  COORDINATOR_DELEGATION_GUIDANCE,
  NO_NATIVE_SUBAGENT_GUIDANCE,
  RUN_MINTING_COST_NOTE,
  delegationGuidanceFor,
  hasHarnessSubagents,
  hasNativeToolSurface,
  resolveSubagentBackend,
  type DelegationRun,
} from "../lib/delegation-guidance";
import {
  isSubagentTool,
  hasNativeSubagents,
  subagentToolName,
  subagentToolsFor,
} from "../lib/subagent-tools";
import { canonicalToolName, interceptorToolName } from "../lib/builtin-tools";
import { delegationGuidanceFactory } from "../lib/extensions/delegation";
import { alwaysOnExtensions } from "../lib/profiles";
import { ORCHESTRATOR_TOOLS } from "../lib/orchestrator-tools";
import { SPAWN_TOOLS } from "../lib/extensions/spawn";
import { makeRegistrar } from "./helpers/fake-registrar";
import type { RunRow } from "../lib/runs";

function run(overrides: Partial<DelegationRun> = {}): DelegationRun {
  return {
    id: 1,
    runtime: "worker",
    toolsProfile: "orchestrator,repo_write,gh_pr,gh_ci",
    personaId: "implementor",
    backend: "claude",
    ...overrides,
  };
}

describe("subagent tool table", () => {
  it("names Claude's current tool first and keeps the legacy spelling for detection", () => {
    expect(subagentToolName("claude")).toBe("Agent");
    expect(subagentToolsFor("claude")).toEqual(["Agent", "Task"]);
    expect(isSubagentTool("claude", "Agent")).toBe(true);
    expect(isSubagentTool("claude", "Task")).toBe(true);
    // The work-item tools are a different mechanism entirely.
    expect(isSubagentTool("claude", "TaskCreate")).toBe(false);
    expect(isSubagentTool("claude", "spawn_agent")).toBe(false);
  });

  it("names Codex's v2 tool and still detects the v1 namespace", () => {
    expect(subagentToolName("codex")).toBe("spawn_agent");
    expect(isSubagentTool("codex", "spawn_agent")).toBe(true);
    expect(isSubagentTool("codex", "multi_agent_v1.spawn_agent")).toBe(true);
    expect(isSubagentTool("codex", "Agent")).toBe(false);
  });

  it("reports that pi has no native sub-agent at all", () => {
    expect(hasNativeSubagents("pi")).toBe(false);
    expect(subagentToolName("pi")).toBeNull();
    expect(isSubagentTool("pi", "task")).toBe(false);
  });
});

describe("canonical vocabulary", () => {
  it("folds every harness spelling of a spawn onto one identity", () => {
    expect(canonicalToolName("Agent")).toBe("Agent");
    expect(canonicalToolName("Task")).toBe("Agent");
    expect(canonicalToolName("spawn_agent")).toBe("Agent");
    expect(canonicalToolName("multi_agent_v1.spawn_agent")).toBe("Agent");
  });

  it("gives the interceptor seam one name to key on", () => {
    expect(interceptorToolName("Agent")).toBe("agent");
    expect(interceptorToolName("Task")).toBe("agent");
    expect(interceptorToolName("spawn_agent")).toBe("agent");
  });
});

describe("resolveSubagentBackend", () => {
  it("takes the run's backend when it names one", () => {
    expect(resolveSubagentBackend("claude")).toBe("claude");
    expect(resolveSubagentBackend("codex")).toBe("codex");
  });

  it("falls back to pi rather than throwing on an absent or unknown id", () => {
    expect(resolveSubagentBackend(null)).toBe("pi");
    expect(resolveSubagentBackend("not-a-backend")).toBe("pi");
  });
});

describe("hasNativeToolSurface / hasHarnessSubagents", () => {
  it("gives a containerized worker run the native surface", () => {
    expect(hasNativeToolSurface(run())).toBe(true);
    expect(hasHarnessSubagents(run())).toBe(true);
    expect(hasHarnessSubagents(run({ backend: "codex" }))).toBe(true);
  });

  it("grants pi the surface but not a sub-agent — its built-ins have none", () => {
    expect(hasNativeToolSurface(run({ backend: "pi" }))).toBe(true);
    expect(hasHarnessSubagents(run({ backend: "pi" }))).toBe(false);
  });

  it("withholds both from the executor — its native tools are blocked", () => {
    const executor = run({ personaId: "executor", toolsProfile: "orchestrator,spawn" });
    expect(hasNativeToolSurface(executor)).toBe(false);
    expect(hasHarnessSubagents(executor)).toBe(false);
  });

  it("withholds both from a server-runtime run — the in-process loop mounts no native tools", () => {
    const concierge = run({
      personaId: "concierge",
      runtime: "server",
      toolsProfile: "orchestrator,spawn",
      backend: "pi",
    });
    expect(hasNativeToolSurface(concierge)).toBe(false);
  });

  it("treats a legacy server row that run-runtime demotes as the worker run it is", () => {
    expect(
      hasNativeToolSurface(run({ runtime: "server", toolsProfile: "orchestrator,repo_write" }))
    ).toBe(true);
  });
});

describe("delegationGuidanceFor", () => {
  it("always opens with the child-run cost rule", () => {
    for (const backend of ["claude", "codex", "pi"] as const) {
      expect(delegationGuidanceFor(run({ backend }))).toContain(CHILD_RUN_ECONOMY_RULE.trim());
    }
  });

  it("names Claude's Agent tool, with its call shape, on a Claude run", () => {
    const text = delegationGuidanceFor(run({ backend: "claude" }));
    expect(text).toContain(CLAUDE_SUBAGENT_GUIDANCE.trim());
    expect(text).toMatch(/Agent\(subagent_type, description, prompt\)/);
    expect(text).not.toContain("spawn_agent(task_name");
  });

  it("names Codex's spawn_agent, with its call shape, on a Codex run", () => {
    const text = delegationGuidanceFor(run({ backend: "codex" }));
    expect(text).toContain(CODEX_SUBAGENT_GUIDANCE.trim());
    expect(text).toMatch(/spawn_agent\(task_name, message\)/);
    expect(text).not.toMatch(/Agent\(subagent_type/);
  });

  it("tells a pi run it has no sub-agent tool instead of naming one", () => {
    const text = delegationGuidanceFor(run({ backend: "pi" }));
    expect(text).toContain(NO_NATIVE_SUBAGENT_GUIDANCE.trim());
    expect(text).not.toContain("spawn_agent(task_name");
    expect(text).not.toMatch(/Agent\(subagent_type/);
  });

  it("gives a coordinator with no native tools the economy rule alone", () => {
    const text = delegationGuidanceFor(run({ personaId: "executor", backend: "claude" }));
    expect(text).toContain(COORDINATOR_DELEGATION_GUIDANCE.trim());
    // Never point an agent at a tool it was not given.
    expect(text).not.toMatch(/Agent\(subagent_type/);
    expect(text).not.toContain("spawn_agent(task_name");
  });
});

describe("delegationGuidanceFactory", () => {
  it("appends to the base prompt so the persona still leads it", async () => {
    const r = makeRegistrar();
    delegationGuidanceFactory(run())(r.reg);
    const composed = await r.composePrompt("YOU ARE AN IMPLEMENTOR.");
    expect(composed.startsWith("YOU ARE AN IMPLEMENTOR.")).toBe(true);
    expect(composed).toContain(CLAUDE_SUBAGENT_GUIDANCE.trim());
  });

  it("stands alone when the backend supplies no base prompt", async () => {
    const r = makeRegistrar();
    delegationGuidanceFactory(run())(r.reg);
    expect(await r.composePrompt("")).toBe(delegationGuidanceFor(run()).trim());
  });
});

describe("alwaysOnExtensions", () => {
  async function composeFor(runRow: DelegationRun): Promise<string> {
    const factories = await alwaysOnExtensions({
      runId: runRow.id,
      run: runRow as unknown as RunRow,
      author: "claude-agent",
      taskId: null,
      planId: null,
      cwd: "/tmp",
    });
    const r = makeRegistrar();
    for (const factory of factories) await factory(r.reg);
    return r.composePrompt("BASE");
  }

  it("carries the run's own harness flavour, whatever its tools profile", async () => {
    expect(await composeFor(run({ backend: "claude" }))).toContain(CLAUDE_SUBAGENT_GUIDANCE.trim());
    expect(await composeFor(run({ backend: "codex" }))).toContain(CODEX_SUBAGENT_GUIDANCE.trim());
    expect(await composeFor(run({ backend: "pi" }))).toContain(NO_NATIVE_SUBAGENT_GUIDANCE.trim());
  });

  it("carries the coordinator flavour for a run with no native tools", async () => {
    const text = await composeFor(
      run({ personaId: "executor", toolsProfile: "orchestrator,spawn" })
    );
    expect(text).toContain(COORDINATOR_DELEGATION_GUIDANCE.trim());
  });
});

describe("run-minting tools state their cost", () => {
  it("start_session carries the note", () => {
    const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === "start_session");
    expect(tool?.description).toContain(RUN_MINTING_COST_NOTE);
  });

  it("spawn__spawn_agent carries the note", () => {
    const tool = SPAWN_TOOLS.find((t) => t.name === "spawn__spawn_agent");
    expect(tool?.description).toContain(RUN_MINTING_COST_NOTE);
  });

  it("the note names both harnesses' sub-agent tools, since the registry is shared", () => {
    expect(RUN_MINTING_COST_NOTE).toContain("Agent(subagent_type, prompt)");
    expect(RUN_MINTING_COST_NOTE).toContain("spawn_agent(task_name, message)");
    expect(RUN_MINTING_COST_NOTE).toMatch(/One run per task, not per step/);
  });
});
