import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  CODEACT_CATALOG_TOOL,
  CODEACT_EXECUTE_TOOL,
  neutralCodeActCatalog,
  withCodeActCapabilities,
} from "../../lib/agent-backend/codeact-capabilities";
import type { CollectedCapabilities } from "../../lib/agent-backend/collect";
import type { NeutralTool, ToolCallInterceptor } from "../../lib/agent-backend/types";

function tool(overrides: Partial<NeutralTool> = {}): NeutralTool {
  return {
    name: "task_orch__list_tasks",
    description: "List tasks",
    parameters: Type.Object({ state: Type.Optional(Type.String()) }),
    execute: async (_callId, params) => ({
      content: [{ type: "text", text: JSON.stringify(params) }],
    }),
    ...overrides,
  };
}

function collected(tools: NeutralTool[], interceptors: ToolCallInterceptor[] = []): CollectedCapabilities {
  return {
    tools,
    interceptors,
    systemPromptFns: [(base) => `${base}persona`],
    agentStartFns: [() => undefined],
    skills: [{ name: "memory", description: "d", body: "b" }],
  };
}

function codeActTool(capabilities: CollectedCapabilities): NeutralTool {
  const found = capabilities.tools.find((entry) => entry.name === CODEACT_EXECUTE_TOOL);
  if (!found) throw new Error("missing CodeAct executor");
  return found;
}

function resultJson(result: Awaited<ReturnType<NeutralTool["execute"]>>): any {
  const text = result.content.find((block) => block.type === "text") as { text?: string } | undefined;
  return JSON.parse(text?.text ?? "null");
}

describe("backend-neutral CodeAct capabilities", () => {
  it("exposes only the shared execute/catalog contract while retaining internal handlers and hooks", async () => {
    const direct = tool();
    const base = collected([direct]);
    const augmented = withCodeActCapabilities(base);

    expect(augmented.tools.map((entry) => entry.name)).toEqual([
      CODEACT_CATALOG_TOOL,
      CODEACT_EXECUTE_TOOL,
    ]);
    expect(augmented.interceptors).toBe(base.interceptors);
    expect(augmented.systemPromptFns.slice(0, -1)).toEqual(base.systemPromptFns);
    expect(augmented.agentStartFns).toBe(base.agentStartFns);
    expect(augmented.skills).toBe(base.skills);

    const catalogTool = augmented.tools.find((entry) => entry.name === CODEACT_CATALOG_TOOL)!;
    const description = resultJson(await catalogTool.execute("catalog", { names: ["tools.list_tasks"] }));
    expect(description.operations).toHaveLength(1);
    expect(description.operations[0]).toMatchObject({
      name: "list_tasks",
      sdkPath: "app.tasks.list",
      aliases: expect.arrayContaining(["tools.list_tasks", "tools.task_orch__list_tasks"]),
    });
  });

  it("resolves app and compatibility aliases and runs canonical interceptors on every subcall", async () => {
    const calls: Array<{ callId: string; state: string }> = [];
    const seen: string[] = [];
    const direct = tool({
      execute: async (callId, params) => {
        calls.push({ callId, state: params.state });
        return { content: [{ type: "text", text: params.state }] };
      },
    });
    const augmented = withCodeActCapabilities(collected([direct], [({ toolName, input }) => {
      seen.push(`${toolName}:${input.state}`);
      return { input: { state: `checked-${input.state}` } };
    }]));

    const result = await codeActTool(augmented).execute("outer-call", {
      code: `
        return await Promise.all([
          app.tasks.list({ state: "app" }),
          tools.list_tasks({ state: "compat" }),
          tools.task_orch__list_tasks({ state: "prefixed" })
        ]);
      `,
    });

    expect(result.isError).toBe(false);
    expect(seen).toEqual([
      "task_orch__list_tasks:app",
      "task_orch__list_tasks:compat",
      "task_orch__list_tasks:prefixed",
    ]);
    expect(calls.map((call) => call.state)).toEqual(["checked-app", "checked-compat", "checked-prefixed"]);
    expect(new Set(calls.map((call) => call.callId)).size).toBe(3);
    expect(resultJson(result)).toMatchObject({ status: "completed", result: expect.any(Array) });
  });

  it("returns structured operation errors for schema failures and interceptor denials", async () => {
    const execute = codeActTool(withCodeActCapabilities(collected([tool()], [() => ({
      block: true,
      reason: "planning stage forbids this call",
    })])));

    const blocked = await execute.execute("outer", {
      code: "return await app.tasks.list({ state: 'todo' });",
    });
    expect(blocked.isError).toBe(true);
    expect(resultJson(blocked).error).toMatchObject({
      name: "CodeActOperationError",
      code: "forbidden",
      operationId: "app.tasks.list",
      retryable: false,
      message: "planning stage forbids this call",
    });

    const invalid = await codeActTool(withCodeActCapabilities(collected([tool()]))).execute("outer", {
      code: "return await app.tasks.list({ state: 42 });",
    });
    expect(resultJson(invalid).error).toMatchObject({
      code: "invalid_params",
      operationId: "app.tasks.list",
    });
  });

  it("preserves image blocks and artifact handles in model-visible output", async () => {
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } as const;
    const attachment = tool({
      name: "task_orch__get_attachment",
      description: "Get attachment",
      parameters: Type.Object({ id: Type.Number() }),
      execute: async () => ({ content: [{ type: "text", text: "image.png" }, image] }),
    });
    const execute = codeActTool(withCodeActCapabilities(collected([attachment])));
    const result = await execute.execute("outer", {
      code: `
        const attachment = await app.attachments.get({ id: 7 });
        output.image(attachment.content.find(block => block.type === "image"));
        output.text({ kind: "artifact", handle: "artifact:7", mimeType: "text/plain" });
        return { attachment: 7 };
      `,
    });

    expect(result.content).toContainEqual(image);
    expect(resultJson(result)).toMatchObject({
      status: "completed",
      outputs: expect.arrayContaining([
        { kind: "text", value: { kind: "artifact", handle: "artifact:7", mimeType: "text/plain" } },
      ]),
    });
  });

  it("cancels the sandbox through the turn AbortSignal and drops late work", async () => {
    const abort = new AbortController();
    const direct = tool({ execute: vi.fn(async () => ({ content: [] })) });
    const execute = codeActTool(withCodeActCapabilities(collected([direct]), abort.signal));
    const pending = execute.execute("outer", { code: "while (true) {}" });
    setTimeout(() => abort.abort(), 20);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({ status: "cancelled" });
    expect(direct.execute).not.toHaveBeenCalled();
  });

  it("closes dispatch after a successful terminal lifecycle operation", async () => {
    const finish = tool({ name: "report_result", parameters: Type.Object({}) });
    const list = tool();
    const execute = codeActTool(withCodeActCapabilities(collected([finish, list])));
    const result = await execute.execute("outer", {
      code: `
        await tools.report_result({});
        try { await tools.list_tasks({}); }
        catch (error) { return { code: error.code, operationId: error.operationId }; }
      `,
    });

    expect(resultJson(result)).toMatchObject({
      status: "completed",
      result: { code: "lifecycle_closed", operationId: "tools.list_tasks" },
    });
  });

  it("describes compatibility aliases from inside the sandbox", async () => {
    const catalog = neutralCodeActCatalog([tool()]);
    expect(catalog.operations[0].aliases).toContain("tools.list_tasks");
    const execute = codeActTool(withCodeActCapabilities(collected([tool()])));
    const result = await execute.execute("outer", {
      code: "return (await catalog.describe({ names: ['tools.list_tasks'] }))[0].sdkPath;",
    });
    expect(resultJson(result).result).toBe("app.tasks.list");
  });
});
