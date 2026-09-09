import { describe, expect, it, vi } from "vitest";
import {
  APP_API_DESCRIPTORS,
  AppApiError,
  dispatchAppOperation,
  discoverAppApi,
  generateTypeScriptDeclarations,
  resolveOperation,
} from "../lib/app-api";

describe("shared app-api registry and dispatcher", () => {
  it("discovers versioned descriptors with SDK, alias, policy, and execution metadata", () => {
    const catalog = discoverAppApi();
    expect(catalog.version).toBe("v1");
    expect(catalog.operations.length).toBe(APP_API_DESCRIPTORS.length);
    const task = resolveOperation("create_task");
    expect(task).toMatchObject({
      version: "v1",
      sdkPath: "app.tasks.create",
      executionLocation: "control-plane",
      serverSafe: true,
    });
    expect(task?.aliases).toEqual(expect.arrayContaining(["task_orch__create_task", "tools.create_task"]));
    expect(task?.effects).toContain("create");
  });

  it("resolves legacy aliases to the canonical operation", () => {
    expect(resolveOperation("task_orch__list_tasks")?.name).toBe("list_tasks");
    expect(resolveOperation("mcp__task_orch__get_task")?.name).toBe("get_task");
  });

  it("validates arguments and enforces capabilities and resources before execution", async () => {
    await expect(
      dispatchAppOperation("create_plan", { title: 42 }, { author: "test" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    await expect(
      dispatchAppOperation("list_tasks", {}, { author: "test", capabilities: ["app:get_task"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      dispatchAppOperation("get_task", { id: "T-other" }, { author: "test", defaultTaskId: "T-scope" }),
    ).rejects.toMatchObject({ code: "resource_forbidden" });
  });

  it("runs canonical interceptors and planning gates per subcall", async () => {
    const interceptor = vi.fn(() => "blocked by policy");
    await expect(
      dispatchAppOperation("list_tasks", {}, { author: "test", interceptors: [interceptor] }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(interceptor).toHaveBeenCalledOnce();
    await expect(
      dispatchAppOperation("create_task", {}, { author: "test", planningStage: "spec_review" }),
    ).rejects.toMatchObject({ code: "planning_stage" });
  });

  it("emits declarations from the same descriptor catalog", () => {
    const declarations = generateTypeScriptDeclarations();
    expect(declarations).toContain("tasks_create");
    expect(declarations).toContain("repositories_list");
  });
});
