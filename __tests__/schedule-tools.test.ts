import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAppOperation, resolveOperation, APP_API_DESCRIPTORS } from "../lib/app-api";
import { SCHEDULE_TOOLS } from "../lib/schedule-tools";
import { allowedServerTools, appCapabilitiesForTools } from "../lib/worker/server-policy";
import { executeServerTool, resolveServerTool } from "../lib/worker/server-tools";
import { codeActCatalogForContext } from "../lib/codeact/catalog";
import { executeAppCodeAct } from "../lib/codeact/app-bridge";
import { orchestratorExtension } from "../lib/extensions/agent";
import { collectExtensions } from "../lib/agent-backend/collect";
import { withCodeActCapabilities } from "../lib/agent-backend/codeact-capabilities";
import { makeRegistrar } from "./helpers/fake-registrar";
import * as schedules from "../lib/schedules";
import * as runs from "../lib/runs";
import * as users from "../lib/users";

afterEach(() => vi.restoreAllMocks());
const parse = (result: { content: { type: string; [key: string]: unknown }[] }) =>
  JSON.parse(result.content[0].text as string);
const base = { name: "Scheduled maintenance", prompt: "Review dependencies", repoId: "R-default" };
const context = async () => ({
  author: "test", runtime: "server" as const,
  capabilities: appCapabilitiesForTools(await allowedServerTools("orchestrator")),
});

describe("scheduled jobs in the agent toolbelt", () => {
  it("keeps schedule handlers internal and exposes authorized operations only in CodeAct", async () => {
    const ctx = await context();
    const allowed = await allowedServerTools("orchestrator");
    const denied = await allowedServerTools("repo_read");
    const catalog = codeActCatalogForContext(ctx, {}, { query: "app.schedules." });
    expect(catalog.operations).toHaveLength(8);
    expect(codeActCatalogForContext({ ...ctx, capabilities: appCapabilitiesForTools(denied) }, {}, { query: "app.schedules." }).operations).toEqual([]);
    const invoke = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "[]" }] });
    const reg = makeRegistrar();
    orchestratorExtension({ author: "test", invoke })(reg.reg);
    const surface = withCodeActCapabilities(await collectExtensions([orchestratorExtension({ author: "test", invoke })]));
    expect(surface.tools.map((tool) => tool.name)).toEqual(["codeact_catalog", "codeact_execute"]);
    const description = parse(await surface.tools[0].execute("catalog", { query: "app.schedules." }));
    expect(description.operations).toHaveLength(8);
    for (const tool of SCHEDULE_TOOLS) {
      expect(allowed).toContain(tool.name);
      expect(denied).not.toContain(tool.name);
      expect(await resolveServerTool(tool.name)).toBe(tool);
      const descriptor = resolveOperation(tool.name)!;
      expect(APP_API_DESCRIPTORS.filter((d) => d.sdkPath === descriptor.sdkPath)).toHaveLength(1);
      expect(resolveOperation(`task_orch__${tool.name}`)).toBe(descriptor);
      expect(resolveOperation(`tools.${tool.name}`)).toBe(descriptor);
      expect(descriptor.schema).toHaveProperty("properties");
      const mounted = reg.tools.get(`task_orch__${tool.name}`)!;
      expect(mounted).toBeDefined();
      await mounted.execute("call", { id: 1 });
      expect(invoke).toHaveBeenLastCalledWith(tool.name, { id: 1 });
    }
    await expect(dispatchAppOperation("schedules_list", {}, { ...ctx, capabilities: [] })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("creates jobs through the CodeAct guest with the orchestrator profile", async () => {
    const result = await executeAppCodeAct({
      context: await context(),
      code: `const result = await app.schedules.create(${JSON.stringify({ ...base, kind: "cron", cronExpression: "0 9 * * 1", timezone: "Europe/Amsterdam" })}); return JSON.parse(result.content[0].text);`,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.value).toMatchObject({ kind: "cron", timezone: "Europe/Amsterdam", autoMerge: false, userId: null });
  });

  it("preserves one-time dates and owners on unrelated edits and inherits run attribution", async () => {
    const owner = await users.createUser("schedule-owner@example.com", "test-password");
    const run = await runs.create({ goal: "<chat>", repoId: "R-default", userId: owner.id, defer: true });
    const ctx = { ...await context(), runId: run.id };
    const date = "2099-09-12T09:00:00.000Z";
    const created = parse(await executeServerTool((await resolveServerTool("schedules_create"))!, { ...base, kind: "once", runAt: date, userId: 999 }, ctx));
    expect(created).toMatchObject({ runAt: date, userId: owner.id });
    const updated = parse(await dispatchAppOperation("app.schedules.update", { id: created.id, name: "Renamed", model: null, userId: 999 }, await context()));
    expect(updated).toMatchObject({ name: "Renamed", runAt: date, userId: owner.id, model: null });
    expect(updated.nextRunAt).toBe(date);
  });

  it("supports the lifecycle through internal SDK handlers without dispatching real agents", async () => {
    const ctx = await context();
    const created = parse(await dispatchAppOperation("schedules_create", { ...base, kind: "interval", intervalSeconds: 3600 }, ctx));
    expect(parse(await dispatchAppOperation("tools.schedules_list", {}, ctx))).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]));
    expect(parse(await dispatchAppOperation("schedules_get", { id: created.id }, ctx))).toMatchObject({ id: created.id });
    expect(parse(await dispatchAppOperation("schedules_pause", { id: created.id }, ctx))).toMatchObject({ enabled: false });
    expect(parse(await dispatchAppOperation("schedules_resume", { id: created.id }, ctx))).toMatchObject({ enabled: true });
    const trigger = vi.spyOn(schedules, "runScheduleNow").mockResolvedValue(123);
    expect(parse(await dispatchAppOperation("app.schedules.runNow", { id: created.id }, ctx))).toEqual({ occurrenceId: 123 });
    expect(trigger).toHaveBeenCalledWith(created.id);
    expect(parse(await dispatchAppOperation("schedules_delete", { id: created.id }, ctx))).toMatchObject({ enabled: false });
    expect(await schedules.getSchedule(created.id)).toBeNull();
  });

  it("validates tool parameters and delegates cadence validation to the shared service", async () => {
    const ctx = await context();
    for (const params of [{}, { id: 0 }, { id: "oops" }]) {
      await expect(dispatchAppOperation("schedules_get", params, ctx)).rejects.toMatchObject({ code: "invalid_params" });
    }
    await expect(dispatchAppOperation("schedules_create", { ...base, kind: "once", runAt: "not-a-date" }, ctx)).rejects.toThrow();
    await expect(dispatchAppOperation("schedules_create", { ...base, kind: "cron", cronExpression: "bad cron" }, ctx)).rejects.toThrow(/five fields/);
    await expect(dispatchAppOperation("schedules_create", { ...base, kind: "once" }, ctx)).rejects.toThrow(/runAt/);
  });
});
