import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { collectExtensions } from "../lib/agent-backend/collect";
import { withCodeActTools } from "../lib/agent-backend/codeact-server-capabilities";

describe("Pi CodeAct neutral collection", () => {
  it("exposes only CodeAct while preserving internal handlers, hooks and skills", async () => {
    const interceptor = vi.fn();
    const start = vi.fn();
    const collected = await collectExtensions([
      (reg) => {
        reg.registerTool({
          name: "example",
          description: "example direct operation",
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
        });
        reg.transformSystemPrompt((base) => `${base}:persona`);
        reg.interceptToolCall(interceptor);
        reg.onAgentStart(start);
        reg.addAmbientSkill({ name: "memory", description: "memory", body: "body" });
      },
    ]);
    const augmented = withCodeActTools(collected, undefined);
    expect(augmented.tools.map((tool) => tool.name)).toEqual([
      "codeact_catalog",
      "codeact_execute",
    ]);
    expect(augmented.interceptors).toEqual([interceptor]);
    expect(augmented.agentStartFns).toEqual([start]);
    expect(augmented.skills).toEqual(collected.skills);
    expect(augmented.systemPromptFns).toHaveLength(2);

    const execute = augmented.tools.find((tool) => tool.name === "codeact_execute")!;
    const result = await execute.execute("call-1", { code: "return await tools.example({});" });
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("ok") });
    expect(interceptor).toHaveBeenCalled();
  });

  it("always enables CodeAct without an opt-in invoker", async () => {
    const collected = await collectExtensions([]);
    expect(withCodeActTools(collected, undefined).tools.map((tool) => tool.name)).toEqual(["codeact_catalog", "codeact_execute"]);
  });
  it("forwards covered operations durably and retains only helpers absent from the server SDK", async () => {
    const collected = await collectExtensions([(reg) => {
      for (const name of ["task_orch__list_tasks", "task_orch__schedules_create", "report_result", "repo__read_file", "gh_pr__pr_view", "brave__web_search"]) {
        reg.registerTool({ name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [] }) });
      }
    }]);
    const invoke = vi.fn(async () => ({ content: [{ type: "text" as const, text: "receipt" }] }));
    const surface = withCodeActTools(collected, invoke);
    expect(surface.tools.map((tool) => tool.name)).toEqual([
      "repo__read_file", "gh_pr__pr_view", "brave__web_search", "codeact_catalog", "codeact_execute",
    ]);
    await surface.tools.find((tool) => tool.name === "codeact_execute")!.execute("outer", { code: "return await app.tasks.list({});" });
    expect(invoke).toHaveBeenCalledWith("codeact_execute", { code: "return await app.tasks.list({});" });
  });

});
