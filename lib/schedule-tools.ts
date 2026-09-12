import { Type, type TSchema } from "typebox";
import type { OrchestratorTool } from "./orchestrator-tools";
import type { AppApiContext, OperationDescriptor, OperationEffect } from "./app-api/types";
import { scheduleApiInputSchema, scheduleApiPatchSchema } from "./validators";

// Keep the wire contract shared by direct tools, MCP and CodeAct. Services are
// imported only by executors; worker extensions only register these schemas.
const text = () => Type.String({ minLength: 1 });
const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
const positiveInt = () => Type.Integer({ minimum: 1 });
const instant = Type.String({ description: "ISO 8601 timestamp with Z or a UTC offset." });
const fields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  prompt: text(),
  repoId: Type.String({ description: "Registered repository ID, e.g. R-default." }),
  kind: Type.Union([Type.Literal("once"), Type.Literal("interval"), Type.Literal("cron")]),
  runAt: Type.Optional(instant),
  startAt: Type.Optional(Type.String({ description: "First interval occurrence as an ISO timestamp; defaults to now." })),
  intervalSeconds: Type.Optional(positiveInt()),
  cronExpression: Type.Optional(Type.String({ description: "Five-field cron expression, e.g. 0 9 * * 1." })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone, e.g. Europe/Amsterdam; defaults to UTC." })),
  baseBranch: Type.Optional(nullable(text())),
  personaId: Type.Optional(nullable(text())),
  model: Type.Optional(nullable(text())),
  toolsProfile: Type.Optional(nullable(text())),
  autoMerge: Type.Optional(Type.Boolean({ description: "Enable squash auto-merge after required checks; defaults to false." })),
  budgetMaxTurns: Type.Optional(nullable(positiveInt())),
  budgetMaxUsd: Type.Optional(nullable(Type.Number({ exclusiveMinimum: 0 }))),
  budgetMaxSeconds: Type.Optional(nullable(positiveInt())),
};
const createParams = Type.Object(fields);
const idParams = Type.Object({ id: positiveInt() });
const updateParams = Type.Object({
  ...Type.Partial(createParams).properties,
  id: positiveInt(),
  runAt: Type.Optional(nullable(instant)),
  intervalSeconds: Type.Optional(nullable(positiveInt())),
  cronExpression: Type.Optional(nullable(text())),
});

type Handler = (params: any, ctx: AppApiContext) => Promise<unknown>;
function operation(
  name: string, method: string, description: string, parameters: TSchema,
  effect: OperationEffect, capability: string, handler: Handler,
): OperationDescriptor {
  const tool: OrchestratorTool = {
    name, label: description, description, parameters,
    execute: async (params, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await handler(params, ctx)) }] }),
  };
  return {
    version: "v1", name, sdkPath: `app.schedules.${method}`, description,
    schema: parameters, aliases: [`task_orch__${name}`, `tools.${name}`],
    effects: [effect], capabilities: [`schedules:${capability}`, `app:${name}`],
    executionLocation: "control-plane", serverSafe: true, tool,
  };
}

export const SCHEDULE_API_DESCRIPTORS = [
  operation("schedules_list", "list", "List scheduled jobs and their latest task, run and PR.", Type.Object({}), "read", "read",
    async () => (await import("./schedules")).listScheduleSurfaces()),
  operation("schedules_get", "get", "Get a scheduled job and its latest occurrence.", idParams, "read", "read",
    async ({ id }) => (await import("./schedules")).getScheduleSurface(id)),
  operation("schedules_create", "create",
    "Create a scheduled coding job in a registered repository. Use once with runAt, interval with intervalSeconds, or cron with cronExpression. Each occurrence creates a task and agent run; overlapping runs are skipped.",
    createParams, "create", "write", async (params, ctx) => {
      const schedules = await import("./schedules");
      // Attribution is host-derived, never supplied by tool arguments. MCP
      // callers may have no numeric user; runs inherit their persisted owner.
      const userId = ctx.runId
        ? (await (await import("./runs")).get(ctx.runId))?.userId ?? null
        : ctx.userId ?? null;
      const created = await schedules.createSchedule({ ...scheduleApiInputSchema.parse(params), userId });
      return schedules.getScheduleSurface(created.id);
    }),
  operation("schedules_update", "update",
    "Update supplied scheduled-job fields, preserving omitted settings and owner. Nullable overrides can be reset to inheritance with null.",
    updateParams, "update", "write", async ({ id, ...patch }) => {
      const schedules = await import("./schedules");
      // Parse only supplied fields: injecting runAt: undefined would erase the
      // date of a one-time job on an unrelated edit.
      await schedules.updateSchedule(id, scheduleApiPatchSchema.parse(patch));
      return schedules.getScheduleSurface(id);
    }),
  operation("schedules_pause", "pause", "Pause future occurrences of a scheduled job; an active run continues.", idParams, "transition", "write",
    async ({ id }) => (await import("./schedules")).pauseSchedule(id)),
  operation("schedules_resume", "resume", "Resume a paused scheduled job. Completed or past one-time jobs stay disabled.", idParams, "transition", "write",
    async ({ id }) => (await import("./schedules")).resumeSchedule(id)),
  operation("schedules_run_now", "runNow", "Trigger a scheduled job now without changing its cadence; an active prior run prevents overlap. Returns an occurrence ID; inspect the job to see launch status.", idParams, "execute", "execute",
    async ({ id }) => ({ occurrenceId: await (await import("./schedules")).runScheduleNow(id) })),
  operation("schedules_delete", "delete", "Delete a scheduled job, retaining generated tasks, runs and occurrence history.", idParams, "delete", "write",
    async ({ id }) => (await import("./schedules")).deleteSchedule(id)),
] satisfies OperationDescriptor[];

export const SCHEDULE_TOOLS = SCHEDULE_API_DESCRIPTORS.map(({ tool }) => tool);
