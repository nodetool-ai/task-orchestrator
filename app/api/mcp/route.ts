import { type NextRequest } from "next/server";
import { verifyToken } from "@/lib/api-tokens";
import { getUserById } from "@/lib/users";
import {
  ORCHESTRATOR_TOOLS,
  type OrchestratorContentBlock,
} from "@/lib/orchestrator-tools";
import { validateToolArgs } from "@/lib/tool-args";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// MCP server over Streamable HTTP. Speaks JSON-RPC 2.0.
//
// Auth: Authorization: Bearer tot_<token>. Tokens are issued and revoked
// from /tokens; verification side-effect-bumps last_used_at.
//
// Methods we implement:
//   initialize                 → protocolVersion + capabilities
//   notifications/initialized  → no response (notification)
//   ping                       → {}
//   tools/list                 → all task_orch tools (bare names — no
//                                pi-side prefix) sourced from
//                                lib/orchestrator-tools.ts
//   tools/call                 → dispatches to the same registry the pi
//                                runtime uses
//
// We always return JSON in a single response (not SSE-streamed) — none of
// our tools are long-running enough to need streaming back to the caller.

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

const ParseError = -32700;
const InvalidRequest = -32600;
const MethodNotFound = -32601;
const InvalidParams = -32602;
const InternalError = -32603;

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return jsonResponse({ jsonrpc: JSONRPC_VERSION, id: id ?? null, result });
}

function rpcError(
  id: number | string | null | undefined,
  error: JsonRpcError,
  status = 200
): Response {
  return jsonResponse(
    { jsonrpc: JSONRPC_VERSION, id: id ?? null, error },
    { status }
  );
}

async function authenticate(req: NextRequest): Promise<{ userId: number } | null> {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const verified = await verifyToken(m[1]);
  return verified ? { userId: verified.userId } : null;
}

async function handleInitialize() {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "task-orchestrator",
      version: "1.0.0",
    },
  };
}

function handleToolsList() {
  return {
    tools: ORCHESTRATOR_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      // TypeBox schemas are JSON Schema-shaped; the MCP `inputSchema` field
      // expects a JSON Schema. Pass through as-is.
      inputSchema: t.parameters as unknown,
    })),
  };
}

async function handleToolsCall(
  params: unknown,
  ctx: { author: string }
): Promise<{ content: OrchestratorContentBlock[]; isError?: boolean }> {
  if (typeof params !== "object" || params === null) {
    throw rpcThrow(InvalidParams, "tools/call requires { name, arguments }");
  }
  const { name, arguments: args } = params as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  if (typeof name !== "string") {
    throw rpcThrow(InvalidParams, "tools/call: missing name");
  }
  const tool = ORCHESTRATOR_TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw rpcThrow(MethodNotFound, `Unknown tool: ${name}`);
  }
  // The TypeBox schemas served in tools/list are more than documentation —
  // enforce them here too, the same way the agent backends do (they convert
  // to Zod and let their SDK validate before calling execute). Without this,
  // any bearer-token client can pass a bogus enum or wrong-typed arg straight
  // into repo.* mutations (e.g. create_plan with an unknown `state`).
  const validated = validateToolArgs(tool, args ?? {});
  if (!validated.ok) {
    throw rpcThrow(
      InvalidParams,
      `Invalid params for tool '${name}': ${validated.message}`,
      { issues: validated.issues }
    );
  }
  const result = await tool.execute(validated.value, ctx);
  return { content: result.content, isError: result.isError };
}

class RpcThrow extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}
function rpcThrow(code: number, message: string, data?: unknown): RpcThrow {
  return new RpcThrow(code, message, data);
}

export async function POST(req: NextRequest) {
  const session = await authenticate(req);
  if (!session) {
    return jsonResponse(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  // We need a stable "author" string for orchestrator mutations. Use the
  // user's email so audit trails make sense; fall back to the user id.
  const user = await getUserById(session.userId);
  const author = user?.email ?? `user-${session.userId}`;

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, { code: ParseError, message: "Invalid JSON" }, 400);
  }
  if (body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== "string") {
    return rpcError(body.id, {
      code: InvalidRequest,
      message: "Invalid JSON-RPC envelope",
    });
  }

  try {
    switch (body.method) {
      case "initialize":
        return rpcResult(body.id, await handleInitialize());
      case "notifications/initialized":
        // No response for notifications. Spec says return 202.
        return new Response(null, { status: 202 });
      case "ping":
        return rpcResult(body.id, {});
      case "tools/list":
        return rpcResult(body.id, handleToolsList());
      case "tools/call": {
        const r = await handleToolsCall(body.params, { author });
        return rpcResult(body.id, r);
      }
      default:
        return rpcError(body.id, {
          code: MethodNotFound,
          message: `Unknown method: ${body.method}`,
        });
    }
  } catch (err) {
    if (err instanceof RpcThrow) {
      return rpcError(body.id, {
        code: err.code,
        message: err.message,
        data: err.data,
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return rpcError(body.id, {
      code: InternalError,
      message: msg,
    });
  }
}

// GET is sometimes used by clients to probe / open an SSE stream. We don't
// stream; respond with 405 so clients fall back to POST.
export function GET() {
  return new Response("Method Not Allowed (use POST)", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
