// lib/agent-backend/codex-mcp-bridge.ts
//
// Exposes the run's neutral tools (lib/extensions/*.ts → NeutralTool) to the
// Codex CLI as a Streamable-HTTP MCP server on loopback.
//
// Why a server at all: pi registers tools in-process and the Claude SDK takes an
// in-process MCP server object, but the Codex SDK drives the `codex` CLI as a
// child process — there is no in-process tool seam. The CLI does speak MCP, and
// `mcp_servers.<name>.url` + `bearer_token_env_var` (see `codex mcp add --url`)
// is a first-class config, so the adapter stands up a tiny JSON-RPC endpoint
// bound to 127.0.0.1 on an ephemeral port and points the CLI at it.
//
// Security: the listener is loopback-only and gated on a per-run random bearer
// token handed to the CLI through the environment (never on a command line,
// where it would show up in `ps`). It is torn down when the turn ends.
//
// This is deliberately the same minimal JSON-RPC subset the hosted server
// implements (app/api/mcp/route.ts): initialize, notifications/initialized,
// ping, tools/list, tools/call. None of our tools stream, so every response is
// a single `application/json` body — permitted by the Streamable HTTP transport,
// which only requires SSE when the server chooses to stream.
//
// The tool-call interceptor chain runs HERE, before execute(). That is what
// keeps the planning-stage gates (lib/extensions/planning.ts) enforced on the
// Codex backend: those gates key on orchestrator tool names, and orchestrator
// tools reach Codex only through this bridge. Interceptors that key on the
// built-in shell/patch tools cannot be enforced this way — see the note in
// codex-backend.ts on how those invariants are met instead.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { runInterceptors } from "./collect";
import { validateToolArgs } from "../tool-args";
import { interceptorToolName } from "../builtin-tools";
import type { NeutralTool, ToolCallInterceptor } from "./types";

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

const ParseError = -32700;
const InvalidRequest = -32600;
const MethodNotFound = -32601;
const InvalidParams = -32602;
const InternalError = -32603;

/** Refuse a request body larger than this. Nothing legitimate the CLI sends is
 *  close; the cap just keeps a runaway client from ballooning worker memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface CodexMcpBridge {
  /** URL to hand the CLI as `mcp_servers.<name>.url`. */
  url: string;
  /** Bearer token the CLI must present; goes in the CLI env, not the argv. */
  token: string;
  /** Name of the env var the token is passed through. */
  tokenEnvVar: string;
  close(): Promise<void>;
}

export interface CodexMcpBridgeOptions {
  tools: NeutralTool[];
  interceptors?: ToolCallInterceptor[];
  serverName?: string;
  /** Env var the CLI reads the bearer token from. */
  tokenEnvVar?: string;
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(token);
  // Length differs → not equal, and timingSafeEqual would throw on unequal
  // lengths, so check it first.
  return got.length === want.length && timingSafeEqual(got, want);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Dispatch one JSON-RPC request against the tool set. Exported for unit tests so
 * the protocol surface can be exercised without binding a socket.
 */
export async function handleMcpRequest(
  body: { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown },
  ctx: { tools: NeutralTool[]; interceptors: ToolCallInterceptor[]; serverName: string }
): Promise<{ status: number; body?: unknown }> {
  const id = body.id ?? null;
  if (body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== "string") {
    return {
      status: 200,
      body: {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: InvalidRequest, message: "Invalid JSON-RPC envelope" },
      },
    };
  }

  const ok = (result: unknown) => ({
    status: 200,
    body: { jsonrpc: JSONRPC_VERSION, id, result },
  });
  const fail = (code: number, message: string) => ({
    status: 200,
    body: { jsonrpc: JSONRPC_VERSION, id, error: { code, message } },
  });

  switch (body.method) {
    case "initialize":
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: ctx.serverName, version: "1.0.0" },
      });
    // Notifications carry no id and get no body (spec: 202 Accepted).
    case "notifications/initialized":
    case "notifications/cancelled":
      return { status: 202 };
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: ctx.tools.map((t) => ({
          name: t.name,
          description: t.description,
          // TypeBox schemas are JSON-Schema-shaped; MCP's inputSchema wants
          // JSON Schema. Pass through as-is, like the hosted server does.
          inputSchema: t.parameters as unknown,
        })),
      });
    case "tools/call": {
      const params = body.params;
      if (typeof params !== "object" || params === null) {
        return fail(InvalidParams, "tools/call requires { name, arguments }");
      }
      const { name, arguments: rawArgs } = params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (typeof name !== "string") return fail(InvalidParams, "tools/call: missing name");
      const tool = ctx.tools.find((t) => t.name === name);
      if (!tool) return fail(MethodNotFound, `Unknown tool: ${name}`);

      const validated = validateToolArgs<Record<string, unknown>>(tool, rawArgs ?? {});
      if (!validated.ok) {
        return fail(InvalidParams, `Invalid params for tool '${name}': ${validated.message}`);
      }

      // Interceptors run on the canonical vocabulary, exactly as they do behind
      // Claude's PreToolUse hook and pi's tool_call event.
      let args = validated.value;
      const decision = await runInterceptors(ctx.interceptors, interceptorToolName(name), args);
      if (decision && "block" in decision) {
        // A denial is a tool ERROR, not a transport error: the agent should see
        // the reason and adapt, the way it does on the other two backends.
        return ok({ content: [{ type: "text", text: decision.reason }], isError: true });
      }
      if (decision && "input" in decision) args = decision.input;

      try {
        const result = await tool.execute(randomUUID(), args);
        return ok({ content: result.content, isError: result.isError ?? false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(MethodNotFound, `Unknown method: ${body.method}`);
  }
}

/** Bind the bridge to an ephemeral loopback port and return its coordinates. */
export async function startCodexMcpBridge(
  opts: CodexMcpBridgeOptions
): Promise<CodexMcpBridge> {
  const serverName = opts.serverName ?? "task_orch";
  const tokenEnvVar = opts.tokenEnvVar ?? "TASK_ORCH_CODEX_MCP_TOKEN";
  const token = randomBytes(32).toString("hex");
  const ctx = {
    tools: opts.tools,
    interceptors: opts.interceptors ?? [],
    serverName,
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      // The transport permits a server to refuse the optional GET/DELETE
      // session endpoints; 405 tells the client to stay POST-only.
      if (req.method !== "POST") return send(res, 405, { error: "Method Not Allowed" });
      if (!bearerMatches(req.headers.authorization, token)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="task-orchestrator"');
        return send(res, 401, { error: "Unauthorized" });
      }
      let parsed: any;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, {
          jsonrpc: JSONRPC_VERSION,
          id: null,
          error: { code: ParseError, message: "Invalid JSON" },
        });
      }
      try {
        const out = await handleMcpRequest(parsed, ctx);
        send(res, out.status, out.body);
      } catch (err) {
        send(res, 200, {
          jsonrpc: JSONRPC_VERSION,
          id: parsed?.id ?? null,
          error: {
            code: InternalError,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    throw new Error("Codex MCP bridge failed to bind a loopback port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    tokenEnvVar,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
