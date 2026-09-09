import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { collectExtensions, withCodeActTools } from "../lib/agent-backend/collect";

describe("Pi CodeAct neutral collection", () => {
  it("adds the same outer tools without dropping hooks, skills, or direct tools", async () => {
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
    const invoke = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "forwarded" }],
    }));

    const augmented = withCodeActTools(collected, invoke);
    expect(augmented.tools.map((tool) => tool.name)).toEqual([
      "example",
      "codeact_catalog",
      "codeact_execute",
    ]);
    expect(augmented.interceptors).toEqual([interceptor]);
    expect(augmented.agentStartFns).toEqual([start]);
    expect(augmented.skills).toEqual(collected.skills);
    expect(augmented.systemPromptFns).toHaveLength(2);

    const execute = augmented.tools.find((tool) => tool.name === "codeact_execute")!;
    await expect(execute.execute("call-1", { code: "return 1" })).resolves.toMatchObject({
      content: [{ text: "forwarded" }],
    });
    expect(invoke).toHaveBeenCalledWith("codeact_execute", { code: "return 1" });
  });

  it("is a no-op for backend paths that have not opted in", async () => {
    const collected = await collectExtensions([]);
    expect(withCodeActTools(collected, undefined)).toBe(collected);
  });
});
