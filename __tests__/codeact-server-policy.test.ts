import { describe, expect, it } from "vitest";

import {
  allowedServerTools,
  appCapabilitiesForTools,
} from "../lib/worker/server-policy";

describe("CodeAct server policy", () => {
  it("adds the outer executor without granting worktree or administrative descendants", async () => {
    const tools = await allowedServerTools("orchestrator");
    expect(tools).toEqual(expect.arrayContaining([
      "codeact_catalog",
      "codeact_execute",
      "list_tasks",
      "timer__sleep",
    ]));
    expect(tools).not.toContain("repo__read_file");
    expect(tools).not.toContain("gh_pr__pr_merge");
    expect(tools).not.toContain("admin__delete_user");

    const capabilities = appCapabilitiesForTools(tools);
    expect(capabilities).toContain("app:list_tasks");
    expect(capabilities).not.toContain("app:repo__read_file");
    expect(capabilities).not.toContain("*");
  });
});
