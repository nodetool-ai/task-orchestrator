import { ORCHESTRATOR_TOOLS, type OrchestratorTool } from "../orchestrator-tools";
import { OPERATION_MANIFEST } from "../codeact/operation-manifest";
import {
  APP_API_VERSION,
  type OperationDescriptor,
  type OperationEffect,
} from "./types";

function effectsFor(name: string): OperationEffect[] {
  if (name.startsWith("transition_")) return ["transition"];
  if (name.startsWith("delete_") || name.startsWith("remove_")) return ["delete"];
  if (name.startsWith("create_") || name.startsWith("add_") || name.startsWith("start_")) return ["create"];
  if (name.startsWith("update_") || name.startsWith("check_") || name.startsWith("uncheck_") || name === "set_task_pr") return ["update"];
  if (["gh_pr__pr_review", "gh_pr__pr_comment", "gh_pr__pr_merge", "gh_ci__ci_rerun"].includes(name)) return ["external_write"];
  if (["timer__sleep", "timer__set", "timer__cancel", "events__emit", "report_result", "raise", "answer_question"].includes(name)) return ["execute"];
  return ["read"];
}

function manifestFor(name: string) {
  return OPERATION_MANIFEST.find((entry) => entry.id === `tool:${name}`);
}

function descriptorFor(tool: OrchestratorTool): OperationDescriptor {
  const entry = manifestFor(tool.name);
  const sdkPath = entry?.sdkNamespace ?? `app.${tool.name}`;
  const aliases = [`task_orch__${tool.name}`, `tools.${tool.name}`];
  const planningStages =
    tool.name === "propose_spec" ? ["gathering", "spec_review"] :
    tool.name === "commit_spec_as_plan" ? ["building_plan"] :
    tool.name === "propose_implementation_plan" ? ["building_plan", "plan_review"] :
    ["create_plan", "create_task", "update_task", "transition_task"].includes(tool.name)
      ? ["committing", "done"]
      : undefined;
  return {
    version: APP_API_VERSION,
    name: tool.name,
    sdkPath,
    description: tool.description,
    schema: tool.parameters,
    aliases,
    effects: effectsFor(tool.name),
    executionLocation: "control-plane",
    capabilities: [`app:${tool.name}`, `domain:${entry?.domain ?? "system"}`],
    serverSafe: true,
    ...(planningStages ? { planningStages } : {}),
    tool,
  };
}

/** The canonical v1 operation descriptors. They are derived from the existing
 * implementation registry and the migration manifest, so discovery and the
 * compatibility surfaces cannot silently drift apart. */
export const APP_API_DESCRIPTORS: readonly OperationDescriptor[] =
  ORCHESTRATOR_TOOLS.map(descriptorFor);

const byName = new Map<string, OperationDescriptor>();
for (const descriptor of APP_API_DESCRIPTORS) {
  byName.set(descriptor.name, descriptor);
  byName.set(descriptor.sdkPath, descriptor);
  for (const alias of descriptor.aliases) byName.set(alias, descriptor);
}

export function resolveOperation(name: string): OperationDescriptor | null {
  return byName.get(name) ?? byName.get(name.replace(/^mcp__task_orch__/, "")) ?? null;
}

export function discoverOperations(): readonly OperationDescriptor[] {
  return APP_API_DESCRIPTORS;
}

export function descriptorForTool(tool: OrchestratorTool): OperationDescriptor {
  return descriptorFor(tool);
}

export function operationCatalog() {
  return APP_API_DESCRIPTORS.map(({ tool: _tool, schema, ...descriptor }) => ({
    ...descriptor,
    schema,
  }));
}
