import { validateToolArgs } from "../tool-args";
import { descriptorForTool, resolveOperation } from "./registry";
import {
  AppApiError,
  asAppApiResult,
  type AppApiContext,
  type AppApiResult,
  type OperationDescriptor,
} from "./types";

const CAPABILITY_ALIASES: Record<string, string> = {
  "app:*": "*",
  "domain:*": "*",
};

export function hasAppApiCapability(
  ctx: AppApiContext,
  descriptor: OperationDescriptor,
): boolean {
  if (!ctx.capabilities) return true;
  const grants = new Set(ctx.capabilities);
  return descriptor.capabilities.some((capability) =>
    grants.has(capability) || grants.has(CAPABILITY_ALIASES[capability] ?? "") || grants.has("*"),
  );
}

function stageError(descriptor: OperationDescriptor, stage: string): AppApiError | null {
  if (!descriptor.planningStages || descriptor.planningStages.includes(stage)) return null;
  return new AppApiError(
    "planning_stage",
    `${descriptor.name} is not allowed during planning stage '${stage}'. ` +
      `Allowed stages: ${descriptor.planningStages.join(", ")}.`,
  );
}

function scopeMismatch(descriptor: OperationDescriptor, params: any, ctx: AppApiContext): string | null {
  if (ctx.defaultTaskId && descriptor.sdkPath.startsWith("app.tasks.") &&
      params && typeof params === "object" && typeof params.id === "string" &&
      params.id.startsWith("T-") && params.id !== ctx.defaultTaskId) {
    return `Operation '${descriptor.name}' cannot access task '${params.id}' from task scope '${ctx.defaultTaskId}'.`;
  }
  if (ctx.defaultPlanId && descriptor.sdkPath.startsWith("app.plans.") &&
      params && typeof params === "object" && typeof params.id === "string" &&
      params.id.startsWith("P-") && params.id !== ctx.defaultPlanId) {
    return `Operation '${descriptor.name}' cannot access plan '${params.id}' from plan scope '${ctx.defaultPlanId}'.`;
  }
  if (ctx.defaultTaskId && params && typeof params === "object" && "task_id" in params &&
      params.task_id && params.task_id !== ctx.defaultTaskId) {
    return `Operation '${descriptor.name}' cannot access task '${params.task_id}' from task scope '${ctx.defaultTaskId}'.`;
  }
  if (ctx.defaultPlanId && params && typeof params === "object" && "plan_id" in params &&
      params.plan_id && params.plan_id !== ctx.defaultPlanId) {
    return `Operation '${descriptor.name}' cannot access plan '${params.plan_id}' from plan scope '${ctx.defaultPlanId}'.`;
  }
  return null;
}

/** Dispatch one already-registered tool through the shared policy boundary. */
export async function dispatchTool(
  tool: OperationDescriptor["tool"],
  params: unknown,
  ctx: AppApiContext,
): Promise<AppApiResult> {
  const descriptor = descriptorForTool(tool);
  return dispatchDescriptor(descriptor, params, ctx);
}

export async function dispatchDescriptor(
  descriptor: OperationDescriptor,
  params: unknown,
  ctx: AppApiContext,
): Promise<AppApiResult> {
  if (!hasAppApiCapability(ctx, descriptor)) {
    throw new AppApiError("forbidden", `Operation '${descriptor.name}' is not authorized for this caller.`);
  }
  if (ctx.runtime === "server" && !descriptor.serverSafe) {
    throw new AppApiError("server_unsafe", `Operation '${descriptor.name}' is not safe for server-runtime execution.`);
  }
  if (ctx.planningStage) {
    const error = stageError(descriptor, ctx.planningStage);
    if (error) throw error;
  }
  const scopeError = scopeMismatch(descriptor, params, ctx);
  if (scopeError) throw new AppApiError("resource_forbidden", scopeError);
  if (ctx.authorizeResource) {
    const decision = await ctx.authorizeResource(descriptor, params);
    if (decision !== true && decision !== undefined) {
      throw new AppApiError("resource_forbidden", typeof decision === "string" ? decision : `Resource access denied for '${descriptor.name}'.`);
    }
  }
  const validated = validateToolArgs(descriptor.tool, params ?? {});
  if (!validated.ok) throw new AppApiError("invalid_params", `Invalid params for '${descriptor.name}': ${validated.message}`);
  for (const interceptor of ctx.interceptors ?? []) {
    const decision = await interceptor(descriptor, validated.value, ctx);
    if (typeof decision === "string") throw new AppApiError("forbidden", decision);
  }
  return asAppApiResult(await descriptor.tool.execute(validated.value, ctx));
}

/** Resolve a canonical or compatibility name and dispatch it. */
export async function dispatchAppOperation(
  name: string,
  params: unknown,
  ctx: AppApiContext,
): Promise<AppApiResult> {
  const descriptor = resolveOperation(name);
  if (!descriptor) throw new AppApiError("unknown_operation", `Unknown app operation: ${name}`);
  if (descriptor.executionLocation === "control-plane") {
    // Also support direct SDK callers that have not opened the outer CodeAct
    // tools yet. Registry loading binds real extension schemas and handlers.
    await (await import("../worker/server-tools")).resolveServerTool(descriptor.name);
  }
  return dispatchDescriptor(descriptor, params, ctx);
}
