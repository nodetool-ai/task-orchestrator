// __tests__/git-clone-depth.test.ts
// The in-runner checkout shallows its cold clone via TASK_ORCH_GIT_CLONE_DEPTH
// (default 1) to cut the commit/tree history a large repo transfers. The paired
// --no-single-branch keeps every branch tip so the origin/<base> fallback
// checkout still resolves; depth 0 opts back into a full-history clone.
import { afterEach, describe, expect, it } from "vitest";
import { gitCloneDepthArgs } from "../lib/runs";

afterEach(() => {
  delete process.env.TASK_ORCH_GIT_CLONE_DEPTH;
});

describe("gitCloneDepthArgs()", () => {
  it("defaults to a depth-1 shallow clone across all branch tips", () => {
    delete process.env.TASK_ORCH_GIT_CLONE_DEPTH;
    expect(gitCloneDepthArgs()).toEqual(["--depth", "1", "--no-single-branch"]);
  });

  it("passes a deeper explicit limit through", () => {
    process.env.TASK_ORCH_GIT_CLONE_DEPTH = "25";
    expect(gitCloneDepthArgs()).toEqual(["--depth", "25", "--no-single-branch"]);
  });

  it("emits no depth flags when set to 0 (full-history clone)", () => {
    process.env.TASK_ORCH_GIT_CLONE_DEPTH = "0";
    expect(gitCloneDepthArgs()).toEqual([]);
  });

  it("treats a negative depth as opt-out", () => {
    process.env.TASK_ORCH_GIT_CLONE_DEPTH = "-1";
    expect(gitCloneDepthArgs()).toEqual([]);
  });
});
