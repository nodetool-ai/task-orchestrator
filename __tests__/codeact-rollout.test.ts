import { beforeEach, describe, expect, it } from "vitest";
import { config, resolveToolCallingMode } from "../lib/config";

describe("CodeAct rollout", () => {
  const oldMode = process.env.TASK_ORCH_TOOL_CALLING_MODE;
  const oldPercent = process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT;

  beforeEach(() => {
    if (oldMode === undefined) delete process.env.TASK_ORCH_TOOL_CALLING_MODE;
    else process.env.TASK_ORCH_TOOL_CALLING_MODE = oldMode;
    if (oldPercent === undefined) delete process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT;
    else process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT = oldPercent;
  });

  it("cuts over new runs to CodeAct by default", () => {
    delete process.env.TASK_ORCH_TOOL_CALLING_MODE;
    delete process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT;
    expect(config.agent.toolCallingDefault).toBe("codeact");
    expect(resolveToolCallingMode("stable-run")).toBe("codeact");
  });

  it("supports an immediate direct-mode rollback", () => {
    process.env.TASK_ORCH_TOOL_CALLING_MODE = "direct";
    expect(resolveToolCallingMode("stable-run")).toBe("direct");
  });

  it("uses a stable bounded cohort for controlled rollout", () => {
    process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT = "0";
    expect(resolveToolCallingMode("stable-run")).toBe("direct");
    process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT = "100";
    expect(resolveToolCallingMode("stable-run")).toBe("codeact");
    process.env.TASK_ORCH_CODEACT_ROLLOUT_PERCENT = "37";
    expect(resolveToolCallingMode("stable-run")).toBe(resolveToolCallingMode("stable-run"));
  });
});
