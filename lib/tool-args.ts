// lib/tool-args.ts
//
// Shared arg-validation helper for orchestrator tools. The pi and Claude agent
// backends already convert each tool's TypeBox schema to Zod (via
// lib/agent-backend/typebox-to-zod) and let their SDK validate params before
// calling execute. The MCP HTTP route did not — any bearer-token client could
// call tools/call with a bogus enum or wrong-typed argument and it would flow
// straight into repo.* mutations. This module reuses the same converter so
// every caller enforces the same input contract.
//
// Callers: app/api/mcp/route.ts and lib/agent-backend/codex-mcp-bridge.ts.
// Anything else executing a tool with untrusted params should validate through
// here too.

import { z } from "zod";
import type { TSchema } from "typebox";
import { toZodRawShape } from "./agent-backend/typebox-to-zod";

/** Anything carrying a TypeBox parameter schema: an OrchestratorTool, or a
 *  NeutralTool served over the Codex backend's loopback MCP bridge. */
export interface SchemaBearingTool {
  parameters: TSchema;
}

// Cache converted schemas per tool so repeat tools/call requests don't
// re-walk the TypeBox schema each time. Keyed by tool identity (not name) so
// it works correctly even if a test constructs an ad-hoc tool object.
const schemaCache = new WeakMap<SchemaBearingTool, z.ZodObject<any>>();

function schemaFor(tool: SchemaBearingTool): z.ZodObject<any> {
  let schema = schemaCache.get(tool);
  if (!schema) {
    schema = z.object(toZodRawShape(tool.parameters));
    schemaCache.set(tool, schema);
  }
  return schema;
}

/** Render Zod issues as a single human-readable line, e.g.
 *  "state: Invalid enum value...; title: Required". */
export function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export type ToolArgsResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; issues: z.ZodIssue[] };

/** Validate (and apply defaults from) raw tool-call args against a tool's
 *  TypeBox schema, converted to Zod. Returns either the parsed args or a
 *  structured error — never throws. */
export function validateToolArgs<T = any>(
  tool: SchemaBearingTool,
  args: unknown
): ToolArgsResult<T> {
  const schema = schemaFor(tool);
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const issues = result.error.issues;
    return { ok: false, message: formatZodIssues(issues), issues };
  }
  return { ok: true, value: result.data as T };
}
