import { describe, expect, it } from "vitest";

import { setRunnerInstances, telemetry } from "../lib/runner/telemetry";

describe("runner instance telemetry", () => {
  it("emits persisted Box mappings under the box provider label", async () => {
    setRunnerInstances([
      { provider: "box", state: "stopped", count: 2 },
      { provider: "fly", state: "running", count: 1 },
    ]);

    const metrics = await telemetry().registry.metrics();
    expect(metrics).toContain('task_orch_runner_instances{service="task-orchestrator",provider="box",state="stopped"} 2');
    expect(metrics).toContain('task_orch_runner_instances{service="task-orchestrator",provider="fly",state="running"} 1');
  });
});
