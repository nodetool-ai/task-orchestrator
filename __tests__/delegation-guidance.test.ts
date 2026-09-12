// __tests__/delegation-guidance.test.ts
//
// A child run is a container, a checkout, a budget and a supervision chain;
// a harness subagent is a function call inside the run you already have. These
// tests pin the rule that says so: which flavour of the guidance each run gets,
// that it actually reaches the system prompt through the always-on mount (the
// only seam the ws worker path shares with the legacy runner), and that the two
// tools which MINT a run carry the cost on their own description.

import { describe, expect, it } from "vitest";
import {
  CHILD_RUN_ECONOMY_GUIDANCE,
  IN_RUN_DELEGATION_GUIDANCE,
  RUN_MINTING_COST_NOTE,
  delegationGuidanceFor,
  hasHarnessSubagents,
  type DelegationRun,
} from "../lib/delegation-guidance";
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
    ...overrides,
  };
}

describe("hasHarnessSubagents", () => {
  it("is true for a containerized worker run with a native tool surface", () => {
    expect(hasHarnessSubagents(run())).toBe(true);
  });

  it("is false for the executor — its native tools (Task included) are blocked", () => {
    expect(hasHarnessSubagents(run({ personaId: "executor", toolsProfile: "orchestrator,spawn" })))
      .toBe(false);
  });

  it("is false for a server-runtime persona — the in-process loop mounts no native tools", () => {
    expect(
      hasHarnessSubagents(
        run({ personaId: "concierge", runtime: "server", toolsProfile: "orchestrator,spawn" })
      )
    ).toBe(false);
  });

  it("is true for a legacy server row that run-runtime demotes to a worker", () => {
    // runtime='server' + a non-server-safe profile is driven as a worker run
    // (lib/run-runtime.ts), so it does get the backend's native tools.
    expect(
      hasHarnessSubagents(run({ runtime: "server", toolsProfile: "orchestrator,repo_write" }))
    ).toBe(true);
  });
});

describe("delegationGuidanceFor", () => {
  it("tells a run with subagents to prefer them over minting another run", () => {
    const text = delegationGuidanceFor(run());
    expect(text).toBe(IN_RUN_DELEGATION_GUIDANCE);
    expect(text).toMatch(/subagent tool \(Task on the Claude harness, task on pi\)/);
    expect(text).toMatch(/Do NOT start or spawn another RUN for work you can do here/);
  });

  it("tells a coordinator without subagents to keep it to one run per task", () => {
    const text = delegationGuidanceFor(run({ personaId: "executor" }));
    expect(text).toBe(CHILD_RUN_ECONOMY_GUIDANCE);
    expect(text).toMatch(/One child run per task, not per step/i);
    // Never point an agent at a tool it was not given.
    expect(text).not.toMatch(/your harness's own subagent tool/);
  });
});

describe("delegationGuidanceFactory", () => {
  it("appends to the base prompt so the persona still leads it", async () => {
    const r = makeRegistrar();
    delegationGuidanceFactory(run())(r.reg);
    const composed = await r.composePrompt("YOU ARE AN IMPLEMENTOR.");
    expect(composed.startsWith("YOU ARE AN IMPLEMENTOR.")).toBe(true);
    expect(composed).toContain(IN_RUN_DELEGATION_GUIDANCE.trim());
  });

  it("stands alone when the backend supplies no base prompt", async () => {
    const r = makeRegistrar();
    delegationGuidanceFactory(run())(r.reg);
    expect(await r.composePrompt("")).toBe(IN_RUN_DELEGATION_GUIDANCE.trim());
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

  it("carries the delegation rule into every run, whatever its tools profile", async () => {
    expect(await composeFor(run())).toContain(IN_RUN_DELEGATION_GUIDANCE.trim());
  });

  it("carries the coordinator flavour for a run with no subagents", async () => {
    const text = await composeFor(run({ personaId: "executor", toolsProfile: "orchestrator,spawn" }));
    expect(text).toContain(CHILD_RUN_ECONOMY_GUIDANCE.trim());
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

  it("the note names the cheaper alternative", () => {
    expect(RUN_MINTING_COST_NOTE).toMatch(/subagent tool \(Task\/task\)/);
    expect(RUN_MINTING_COST_NOTE).toMatch(/One run per task, not per step/);
  });
});
