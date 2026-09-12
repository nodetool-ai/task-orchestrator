// Backend-neutral CodeAct surface for SDK-backed workers.
//
// Claude and Codex expose neutral extension tools through different bridges,
// but CodeAct must see one contract. This module is deliberately downstream of
// collectExtensions(): the catalogue contains exactly the tools the run's
// profile mounted, subcalls reuse their executors (and therefore the worker
// channel), and the same interceptor chain runs for every operation.

import { Type } from "typebox";
import { OPERATION_MANIFEST } from "../codeact/operation-manifest";
import { executeCodeAct, type CodeActExecuteResult } from "../codeact/bridge";
import { validateToolArgs } from "../tool-args";
import { interceptorToolName } from "../builtin-tools";
import { runInterceptors, type CollectedCapabilities } from "./collect";
import type { ContentBlock, NeutralTool, ToolResult } from "./types";

export const CODEACT_EXECUTE_TOOL = "codeact_execute";
export const CODEACT_CATALOG_TOOL = "codeact_catalog";

export const CODEACT_BACKEND_GUIDANCE =
  "Use CodeAct exclusively for application operations through codeact_execute({ code, title? }) with the same contract on every backend. " +
  "The JavaScript body may use app.*, tools.* compatibility aliases, catalog.search/describe, output.text, " +
  "output.image, and console. Use codeact_catalog for schemas before the first execution. " +
  "Each execution receives a fresh sandbox; conversation resume does not preserve JavaScript globals. " +
  "Native coding tools remain available for interactive file, patch, search, and process work.";

const CATALOG_LIMIT = 20;
const LIFECYCLE_CLOSING_TOOLS = new Set([
  "timer__sleep",
  "ask_parent",
  "report_result",
  "raise",
  "await_session",
  "propose_spec",
  "propose_implementation_plan",
]);

export interface NeutralCodeActCatalogEntry {
  version: "v1";
  name: string;
  sdkPath: string;
  description: string;
  schema: NeutralTool["parameters"];
  aliases: string[];
  effects: string[];
  executionLocation: "worker";
  capabilities: string[];
  serverSafe: boolean;
}

export interface NeutralCodeActCatalog {
  version: "v1";
  operations: NeutralCodeActCatalogEntry[];
  truncated: boolean;
}

export class NeutralCodeActOperationError extends Error {
  readonly code: string;
  readonly operationId: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(args: {
    code: string;
    message: string;
    operationId: string;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(args.message);
    this.name = "CodeActOperationError";
    this.code = args.code;
    this.operationId = args.operationId;
    this.retryable = args.retryable ?? false;
    this.details = args.details;
  }
}

function bareToolName(name: string): string {
  return name.replace(/^task_orch__/, "");
}

function manifestEntry(name: string) {
  const bare = bareToolName(name);
  return OPERATION_MANIFEST.find((entry) => entry.id === `tool:${bare}` && entry.coverage === "sdk");
}

function effectsFor(name: string): string[] {
  const bare = bareToolName(name);
  if (["sprites_exec", "sprites_startCommand"].includes(bare)) return ["execute"];
  if (["snapshots_prepare", "snapshots_checkpoint"].includes(bare)) return ["create"];
  if (bare === "snapshots_setTarget") return ["update"];
  if (bare === "snapshots_retire") return ["delete"];
  if (bare.startsWith("delete_") || bare.startsWith("remove_")) return ["delete"];
  if (bare.startsWith("create_") || bare.startsWith("add_") || bare.startsWith("start_")) return ["create"];
  if (bare.startsWith("update_") || bare.startsWith("check_") || bare.startsWith("uncheck_")) return ["update"];
  if (bare.startsWith("transition_")) return ["transition"];
  return ["read"];
}

export function neutralCodeActCatalog(tools: readonly NeutralTool[]): NeutralCodeActCatalog {
  const operations = tools
    .filter((tool) => tool.name !== CODEACT_EXECUTE_TOOL && tool.name !== CODEACT_CATALOG_TOOL)
    .map((tool): NeutralCodeActCatalogEntry => {
      const bare = bareToolName(tool.name);
      const manifest = manifestEntry(tool.name);
      const sdkPath = manifest?.sdkNamespace ?? `tools.${tool.name}`;
      const aliases = [...new Set([
        `tools.${bare}`,
        `tools.${tool.name}`,
        tool.name,
      ])];
      return {
        version: "v1",
        name: bare,
        sdkPath,
        description: tool.description,
        schema: tool.parameters,
        aliases,
        effects: effectsFor(tool.name),
        executionLocation: "worker",
        capabilities: [`tool:${tool.name}`],
        serverSafe: false,
      };
    });
  return { version: "v1", operations, truncated: false };
}

function catalogSelection(
  catalog: NeutralCodeActCatalog,
  params: { query?: string; names?: string[] },
): NeutralCodeActCatalog {
  const query = params.query?.trim().toLowerCase();
  const names = new Set(params.names ?? []);
  const operations = catalog.operations.filter((entry) => {
    if (names.size) {
      return names.has(entry.name) || names.has(entry.sdkPath) || entry.aliases.some((alias) => names.has(alias));
    }
    return !query || JSON.stringify(entry).toLowerCase().includes(query);
  }).slice(0, CATALOG_LIMIT);
  return { ...catalog, operations, truncated: operations.length < catalog.operations.length };
}

function toolErrorMessage(result: ToolResult): string {
  const text = result.content
    .filter((block): block is ContentBlock & { text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || "The underlying tool returned an error.";
}

function errorFor(error: unknown, operationId: string): NeutralCodeActOperationError {
  if (error instanceof NeutralCodeActOperationError) return error;
  const source = error as { code?: unknown; retryable?: unknown; details?: unknown } | null;
  return new NeutralCodeActOperationError({
    code: typeof source?.code === "string" ? source.code : "tool_failed",
    message: error instanceof Error ? error.message : String(error),
    operationId,
    retryable: typeof source?.retryable === "boolean" ? source.retryable : false,
    details: source?.details,
  });
}

function inlineImage(value: unknown): { type: "image"; data: string; mimeType: string } | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { type?: unknown; data?: unknown; mimeType?: unknown };
  if ((candidate.type === undefined || candidate.type === "image") &&
      typeof candidate.data === "string" && typeof candidate.mimeType === "string" &&
      candidate.mimeType.startsWith("image/")) {
    return { type: "image", data: candidate.data, mimeType: candidate.mimeType };
  }
  return null;
}

function publicExecutionResult(result: CodeActExecuteResult): Record<string, unknown> {
  return {
    executionId: result.executionId,
    status: result.receipt.status,
    ...("value" in result ? { result: result.value } : {}),
    ...("error" in result ? { error: result.error } : {}),
    ...("reason" in result ? { reason: result.reason } : {}),
    outputs: result.receipt.outputs.map((output) => {
      const image = output.kind === "image" ? inlineImage(output.value) : null;
      return image
        ? { kind: "image", value: { mimeType: image.mimeType, size: image.data.length } }
        : output;
    }),
    diagnostics: result.receipt.diagnostics,
    subcalls: result.receipt.subcalls,
  };
}

function executionToolResult(result: CodeActExecuteResult): ToolResult {
  const summary = publicExecutionResult(result);
  const images = result.receipt.outputs
    .filter((output) => output.kind === "image")
    .map((output) => inlineImage(output.value))
    .filter((block): block is NonNullable<typeof block> => block !== null);
  return {
    content: [{ type: "text", text: JSON.stringify(summary) }, ...images],
    isError: result.status !== "ok",
    details: summary,
  };
}

/**
 * Keep registered handlers private and expose only CodeAct to the model. All
 * backends share this catalogue, validation and interceptor boundary.
 */
export function withCodeActCapabilities(
  collected: CollectedCapabilities,
  signal?: AbortSignal,
): CollectedCapabilities {
  const operationTools = collected.tools.filter(
    (tool) => tool.name !== CODEACT_EXECUTE_TOOL && tool.name !== CODEACT_CATALOG_TOOL,
  );
  const catalog = neutralCodeActCatalog(operationTools);
  const byOperation = new Map<string, NeutralTool>();
  for (const [index, entry] of catalog.operations.entries()) {
    const tool = operationTools[index];
    if (!tool) continue;
    for (const name of [entry.sdkPath, ...entry.aliases]) byOperation.set(name, tool);
  }

  const catalogTool: NeutralTool = {
    name: CODEACT_CATALOG_TOOL,
    label: "CodeAct Catalog",
    description: "Search or describe the bounded CodeAct operations authorized for this run.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      names: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (_callId, params: { query?: string; names?: string[] }) => ({
      content: [{ type: "text", text: JSON.stringify(catalogSelection(catalog, params)) }],
    }),
  };

  const executeTool: NeutralTool = {
    name: CODEACT_EXECUTE_TOOL,
    label: "CodeAct Execute",
    description:
      "Execute an async JavaScript function body in an isolated QuickJS-NG sandbox against this run's authorized app/tools catalogue.",
    parameters: Type.Object({
      code: Type.String(),
      title: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params: { code: string; title?: string }) => {
      let lifecycleClosedBy: string | null = null;
      const result = await executeCodeAct({
        code: params.code,
        title: params.title,
        catalog,
        signal,
        dispatch: async (operation, input, metadata) => {
          if (lifecycleClosedBy) {
            throw new NeutralCodeActOperationError({
              code: "lifecycle_closed",
              message: `CodeAct dispatch closed after lifecycle operation '${lifecycleClosedBy}'. End the execution now.`,
              operationId: operation,
            });
          }
          const target = byOperation.get(operation);
          if (!target) {
            throw new NeutralCodeActOperationError({
              code: "unknown_operation",
              message: `Unknown or unauthorized CodeAct operation: ${operation}`,
              operationId: operation,
            });
          }
          const validated = validateToolArgs<Record<string, unknown>>(target, input ?? {});
          if (!validated.ok) {
            throw new NeutralCodeActOperationError({
              code: "invalid_params",
              message: `Invalid params for '${operation}': ${validated.message}`,
              operationId: operation,
            });
          }
          let args = validated.value;
          const decision = await runInterceptors(
            collected.interceptors,
            interceptorToolName(target.name),
            args,
          );
          if (decision && "block" in decision) {
            throw new NeutralCodeActOperationError({
              code: "forbidden",
              message: decision.reason,
              operationId: operation,
            });
          }
          if (decision && "input" in decision) args = decision.input;
          try {
            const toolResult = await target.execute(metadata.subcallId, args);
            if (toolResult.isError) {
              throw new NeutralCodeActOperationError({
                code: "tool_error",
                message: toolErrorMessage(toolResult),
                operationId: operation,
                details: { content: toolResult.content },
              });
            }
            if (LIFECYCLE_CLOSING_TOOLS.has(bareToolName(target.name))) lifecycleClosedBy = target.name;
            return { content: toolResult.content, isError: false };
          } catch (error) {
            throw errorFor(error, operation);
          }
        },
      });
      return executionToolResult(result);
    },
  };

  return {
    ...collected,
    tools: [catalogTool, executeTool],
    systemPromptFns: [...collected.systemPromptFns, (base) =>
      base ? `${base}\n\n${CODEACT_BACKEND_GUIDANCE}` : CODEACT_BACKEND_GUIDANCE],
  };
}
