import type { TSchema } from "typebox";
import type {
  OrchestratorContentBlock,
  OrchestratorTool,
  OrchestratorToolContext,
  OrchestratorToolResult,
} from "../orchestrator-tools";

export const APP_API_VERSION = "v1" as const;

export type OperationEffect =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "transition"
  | "execute"
  | "external_write";

export type ExecutionLocation = "control-plane" | "worker" | "either";

export interface OperationDescriptor {
  version: typeof APP_API_VERSION;
  name: string;
  /** The stable SDK path, e.g. app.tasks.list. */
  sdkPath: string;
  description: string;
  schema: TSchema;
  aliases: readonly string[];
  effects: readonly OperationEffect[];
  executionLocation: ExecutionLocation;
  capabilities: readonly string[];
  serverSafe: boolean;
  /** Planning stages in which this operation may be called, when gated. */
  planningStages?: readonly string[];
  tool: OrchestratorTool;
}

export interface AppApiContext extends OrchestratorToolContext {
  /** Capability grants for this individual call. Omitted means unrestricted. */
  capabilities?: ReadonlySet<string> | readonly string[];
  runtime?: "server" | "worker" | "control-plane";
  planningStage?: string;
  /** Resource authorization is evaluated for every subcall, before execute. */
  authorizeResource?: (
    descriptor: OperationDescriptor,
    params: unknown,
  ) => Promise<boolean | string> | boolean | string;
  /** Canonical interceptors run after alias resolution and schema validation. */
  interceptors?: readonly AppApiInterceptor[];
}

export type AppApiInterceptor = (
  descriptor: OperationDescriptor,
  params: unknown,
  ctx: AppApiContext,
) => Promise<void | string> | void | string;

export interface AppApiErrorShape {
  code:
    | "unknown_operation"
    | "invalid_params"
    | "forbidden"
    | "resource_forbidden"
    | "planning_stage"
    | "server_unsafe";
  message: string;
}

export class AppApiError extends Error {
  readonly code: AppApiErrorShape["code"];

  constructor(code: AppApiErrorShape["code"], message: string) {
    super(message);
    this.name = "AppApiError";
    this.code = code;
  }
}

export interface AppApiResult {
  content: OrchestratorContentBlock[];
  isError?: boolean;
}

export type AppApiHandler = (
  descriptor: OperationDescriptor,
  params: unknown,
  ctx: AppApiContext,
) => Promise<AppApiResult>;

export function asAppApiResult(result: OrchestratorToolResult): AppApiResult {
  return { content: result.content, isError: result.isError };
}
