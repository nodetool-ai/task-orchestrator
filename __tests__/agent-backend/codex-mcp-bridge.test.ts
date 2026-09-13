import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import {
  handleMcpRequest,
  startCodexMcpBridge,
} from "../../lib/agent-backend/codex-mcp-bridge";
import type { NeutralTool } from "../../lib/agent-backend/types";

function tool(overrides: Partial<NeutralTool> = {}): NeutralTool {
  return {
    name: "task_orch__create_task",
    description: "Create a task",
    parameters: Type.Object({ title: Type.String(), count: Type.Optional(Type.Number()) }),
    execute: async (_id, params) => ({ content: [{ type: "text", text: `ok:${params.title}` }] }),
    ...overrides,
  };
}

const rpc = (method: string, params?: unknown, id: number | string | null = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

const ctx = (over: Partial<Parameters<typeof handleMcpRequest>[1]> = {}) => ({
  tools: [tool()],
  interceptors: [],
  serverName: "task_orch",
  ...over,
});

describe("handleMcpRequest", () => {
  it("answers initialize with tool capability", async () => {
    const out = await handleMcpRequest(rpc("initialize"), ctx());
    expect((out.body as any).result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "task_orch" },
    });
  });

  it("returns 202 with no body for notifications", async () => {
    expect(await handleMcpRequest(rpc("notifications/initialized", undefined, null), ctx())).toEqual({
      status: 202,
    });
  });

  it("serves the TypeBox schema verbatim as the MCP inputSchema", async () => {
    const t = tool();
    const out = await handleMcpRequest(rpc("tools/list"), ctx({ tools: [t] }));
    expect((out.body as any).result.tools).toEqual([
      { name: t.name, description: t.description, inputSchema: t.parameters },
    ]);
  });

  it("executes a tool and returns its content", async () => {
    const out = await handleMcpRequest(
      rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "x" } }),
      ctx()
    );
    expect((out.body as any).result).toEqual({
      content: [{ type: "text", text: "ok:x" }],
      isError: false,
    });
  });

  it("rejects args that violate the tool's schema before execute runs", async () => {
    let ran = false;
    const t = tool({ execute: async () => { ran = true; return { content: [] }; } });
    const out = await handleMcpRequest(
      rpc("tools/call", { name: t.name, arguments: { title: 42 } }),
      ctx({ tools: [t] })
    );
    expect((out.body as any).error.message).toMatch(/Invalid params/);
    expect(ran).toBe(false);
  });

  it("enforces a blocking interceptor as a tool error, not a transport error", async () => {
    // This is what keeps the planning-stage gates alive on the Codex backend:
    // orchestrator tools reach the CLI only through this bridge.
    let ran = false;
    const t = tool({ execute: async () => { ran = true; return { content: [] }; } });
    const out = await handleMcpRequest(
      rpc("tools/call", { name: t.name, arguments: { title: "x" } }),
      ctx({
        tools: [t],
        interceptors: [() => ({ block: true, reason: "use commit_spec_as_plan" })],
      })
    );
    expect((out.body as any).result).toEqual({
      content: [{ type: "text", text: "use commit_spec_as_plan" }],
      isError: true,
    });
    expect(ran).toBe(false);
  });

  it("applies an interceptor's input mutation to the executed args", async () => {
    let seen: any = null;
    const t = tool({
      execute: async (_id, params) => {
        seen = params;
        return { content: [] };
      },
    });
    await handleMcpRequest(
      rpc("tools/call", { name: t.name, arguments: { title: "x" } }),
      ctx({ tools: [t], interceptors: [() => ({ input: { title: "rewritten" } })] })
    );
    expect(seen).toMatchObject({ title: "rewritten" });
  });

  it("turns a throwing tool into an errored result the agent can react to", async () => {
    const t = tool({ execute: async () => { throw new Error("kaboom"); } });
    const out = await handleMcpRequest(
      rpc("tools/call", { name: t.name, arguments: { title: "x" } }),
      ctx({ tools: [t] })
    );
    expect((out.body as any).result).toEqual({
      content: [{ type: "text", text: "kaboom" }],
      isError: true,
    });
  });

  it("rejects an unknown tool, an unknown method, and a bad envelope", async () => {
    const unknownTool = await handleMcpRequest(
      rpc("tools/call", { name: "nope", arguments: {} }),
      ctx()
    );
    expect((unknownTool.body as any).error.message).toMatch(/Unknown tool/);
    const unknownMethod = await handleMcpRequest(rpc("resources/list"), ctx());
    expect((unknownMethod.body as any).error.message).toMatch(/Unknown method/);
    const bad = await handleMcpRequest({ id: 1, method: "ping" } as any, ctx());
    expect((bad.body as any).error.message).toMatch(/Invalid JSON-RPC envelope/);
  });

  it("cancels a request during an asynchronous interceptor before its command can start", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => ({ content: [] }));
    const context = ctx({ tools: [tool({ execute })], activeRequests: new Map(), interceptors: [async () => { await waiting; }] });
    const pending = handleMcpRequest(rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "cancel me" } }, 7), context);
    expect(context.activeRequests!.has(7)).toBe(true);
    await handleMcpRequest(rpc("notifications/cancelled", { requestId: 7 }, null), context);
    release();
    expect((await pending).body).toMatchObject({ result: { isError: true } });
    expect(execute).not.toHaveBeenCalled();
    expect(context.activeRequests!.size).toBe(0);
  });

  it("rejects duplicate active IDs without replacing the original cancellation owner", async () => {
    const execute = vi.fn(async (_callId, _params, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const context = ctx({ tools: [tool({ execute })], activeRequests: new Map() });
    const request = rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "first" } }, "call");
    const pending = handleMcpRequest(request, context);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const duplicate = await handleMcpRequest(request, context);
    expect(duplicate.body).toMatchObject({ error: { message: expect.stringMatching(/already active/) } });
    await handleMcpRequest(rpc("notifications/cancelled", { requestId: "call" }, null), context);
    expect((await pending).body).toMatchObject({ result: { isError: true } });
    expect(execute).toHaveBeenCalledOnce();
    expect(context.activeRequests!.size).toBe(0);
  });
});

describe("startCodexMcpBridge", () => {
  function cancellableTool(signals: Map<string, AbortSignal>): NeutralTool {
    return tool({ execute: async (_callId, params, signal) => {
      signals.set(params.title, signal!);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal!.reason);
        signal!.addEventListener("abort", abort, { once: true });
        if (signal!.aborted) abort();
      });
    } });
  }

  function post(bridge: Awaited<ReturnType<typeof startCodexMcpBridge>>, body: unknown, options: { session?: string; signal?: AbortSignal } = {}) {
    return fetch(bridge.url, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${bridge.token}`,
      ...(options.session ? { "mcp-session-id": options.session } : {}),
    }, body: JSON.stringify(body), signal: options.signal });
  }

  it("binds loopback, requires the bearer token, and serves tools over HTTP", async () => {
    const bridge = await startCodexMcpBridge({ tools: [tool()] });
    try {
      expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(bridge.token).toHaveLength(64);

      const unauthorized = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpc("tools/list")),
      });
      expect(unauthorized.status).toBe(401);

      const wrongToken = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: JSON.stringify(rpc("tools/list")),
      });
      expect(wrongToken.status).toBe(401);

      const authorized = await fetch(bridge.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify(rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "y" } })),
      });
      expect(authorized.status).toBe(200);
      expect(((await authorized.json()) as any).result.content[0].text).toBe("ok:y");

      // The optional session endpoints are declined, keeping the client POST-only.
      const get = await fetch(bridge.url, {
        headers: { authorization: `Bearer ${bridge.token}` },
      });
      expect(get.status).toBe(405);
    } finally {
      await bridge.close();
    }
  });

  // The bridge hand-rolls the JSON-RPC subset the Codex CLI speaks, so prove it
  // against a real MCP client over the same Streamable HTTP transport the CLI
  // uses. Guards the parts a unit test of handleMcpRequest cannot see: the
  // Accept/content-type negotiation, the initialize handshake, and the client's
  // teardown DELETE (which the bridge declines with 405).
  it("interoperates with a real MCP client over Streamable HTTP", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const bridge = await startCodexMcpBridge({ tools: [tool()] });
    try {
      const client = new Client({ name: "codex-bridge-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(bridge.url), {
          requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } },
        })
      );
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(["task_orch__create_task"]);
      expect(
        await client.callTool({ name: "task_orch__create_task", arguments: { title: "T" } })
      ).toMatchObject({ content: [{ type: "text", text: "ok:T" }], isError: false });
      await client.close();
    } finally {
      await bridge.close();
    }
  });

  it("stops answering once closed", async () => {
    const bridge = await startCodexMcpBridge({ tools: [] });
    const url = bridge.url;
    await bridge.close();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("keeps same-numbered nested-client requests isolated when one receives a cancel notification", async () => {
    const signals = new Map<string, AbortSignal>();
    const bridge = await startCodexMcpBridge({ tools: [cancellableTool(signals)] });
    try {
      const initialized = await Promise.all([post(bridge, rpc("initialize")), post(bridge, rpc("initialize"))]);
      const sessions = initialized.map((response) => response.headers.get("mcp-session-id")!);
      await Promise.all(initialized.map((response) => response.json()));
      expect(sessions[0]).toBeTruthy();
      expect(sessions[0]).not.toBe(sessions[1]);
      const calls = ["first", "second"].map((title, index) =>
        post(bridge, rpc("tools/call", { name: "task_orch__create_task", arguments: { title } }, 1), { session: sessions[index] }).then((response) => response.json()));
      await vi.waitFor(() => expect(signals.size).toBe(2));
      expect((await post(bridge, rpc("notifications/cancelled", { requestId: 1 }, null), { session: sessions[0] })).status).toBe(202);
      expect(await calls[0]).toMatchObject({ result: { isError: true } });
      expect(signals.get("first")!.aborted).toBe(true);
      expect(signals.get("second")!.aborted).toBe(false);
      await post(bridge, rpc("notifications/cancelled", { requestId: 1 }, null), { session: sessions[1] });
      expect(await calls[1]).toMatchObject({ result: { isError: true } });
    } finally {
      await bridge.close();
    }
  });

  it("aborts a running tool when its HTTP response connection is abandoned", async () => {
    const signals = new Map<string, AbortSignal>();
    const bridge = await startCodexMcpBridge({ tools: [cancellableTool(signals)] });
    const controller = new AbortController();
    try {
      const pending = post(bridge, rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "abandoned" } }), { signal: controller.signal }).catch((error) => error);
      await vi.waitFor(() => expect(signals.has("abandoned")).toBe(true));
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(signals.get("abandoned")!.aborted).toBe(true));
      expect(String(signals.get("abandoned")!.reason)).toMatch(/disconnected/);
    } finally {
      await bridge.close();
    }
  });

  it("aborts every outstanding tool when the bridge closes and allows repeated close", async () => {
    const signals = new Map<string, AbortSignal>();
    const bridge = await startCodexMcpBridge({ tools: [cancellableTool(signals)] });
    const pending = [1, 2].map((id) => post(bridge, rpc("tools/call", {
      name: "task_orch__create_task", arguments: { title: String(id) },
    }, id)).catch((error) => error));
    try {
      await vi.waitFor(() => expect(signals.size).toBe(2));
      await bridge.close();
      await bridge.close();
      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
      expect([...signals.values()].every((signal) => /bridge closed/.test(String(signal.reason)))).toBe(true);
      await Promise.all(pending);
    } finally {
      await bridge.close();
    }
  });

  it("does not cancel completed tools when their normal HTTP response closes", async () => {
    let signal: AbortSignal | undefined;
    const bridge = await startCodexMcpBridge({ tools: [tool({ execute: async (_id, _params, inputSignal) => {
      signal = inputSignal;
      return { content: [] };
    } })] });
    try {
      await (await post(bridge, rpc("tools/call", { name: "task_orch__create_task", arguments: { title: "complete" } }))).json();
      expect(signal?.aborted).toBe(false);
      await bridge.close();
      expect(signal?.aborted).toBe(false);
    } finally {
      await bridge.close();
    }
  });
});
