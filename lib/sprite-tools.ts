import { Type, type TSchema } from "typebox";
import type { OrchestratorTool } from "./orchestrator-tools";
import type { AppApiContext, OperationDescriptor, OperationEffect } from "./app-api/types";

const text = () => Type.String({ minLength: 1 });
const strings = () => Type.Array(text(), { maxItems: 256 });
const optionalStrings = () => Type.Optional(strings());
const target = { runId: Type.Integer({ minimum: 1 }), generation: Type.Integer({ minimum: 1 }) };
const command = { ...target, command: Type.String({ minLength: 1, maxLength: 64000 }),
  directory: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  commandId: Type.String({ description: "Required stable UUID for this logical command. Reuse the same literal UUID on retries, including retries of the enclosing CodeAct code. Do not generate it dynamically during execution." }) };
const recipe = Type.Object({
  packageManagerVersion: text(),
  nodeVersion: Type.Optional(text()), architecture: Type.Optional(Type.Union([Type.Literal("x64"), Type.Literal("arm64")])),
  installOptions: optionalStrings(), reusePolicy: Type.Optional(Type.Union([Type.Literal("revision"), Type.Literal("inputs")])),
  installScriptInputs: optionalStrings(), setupCommands: optionalStrings(), buildCommands: optionalStrings(), readinessCommands: optionalStrings(),
  workspaceOutputExclusions: optionalStrings(), minimumGitHistoryDepth: Type.Optional(Type.Integer({ minimum: 1 })), baseRef: Type.Optional(text()),
}, { additionalProperties: false });

function operation(domain: "snapshots" | "sprites", method: string, description: string, parameters: TSchema,
  effect: OperationEffect, handler: (params: any, ctx: AppApiContext) => Promise<unknown>): OperationDescriptor {
  const name = `${domain}_${method}`;
  const tool: OrchestratorTool = { name, label: description, description, parameters,
    execute: async (params, ctx) => ({ content: [{ type: "text", text: JSON.stringify(await handler(params, ctx)) }] }) };
  return { version: "v1", name, sdkPath: `app.${domain}.${method}`, description, schema: parameters,
    aliases: [`task_orch__${name}`, `tools.${name}`], effects: [effect], capabilities: [`app:${name}`],
    executionLocation: "control-plane", serverSafe: true, tool };
}

export const SPRITE_API_DESCRIPTORS = [
  operation("snapshots", "list", "List your repository snapshot profiles, targets, preparation status, checkpoints and failures.", Type.Object({}), "read",
    async (_, ctx) => (await import("./sprite-snapshots")).listSnapshots(ctx)),
  operation("snapshots", "prepare", "Configure a durable repository snapshot recipe at a GitHub ref. The server pins immutable inputs; the pool asynchronously installs dependencies, builds, verifies readiness and checkpoints a fresh Sprite. Inspect list for completion. Replaces your repository profile within the existing pool budget.",
    Type.Object({ repoId: text(), ref: text(), target: Type.Optional(Type.Integer({ minimum: 1 })), recipe }), "create",
    async (params, ctx) => (await import("./sprite-snapshots")).prepareSnapshot(ctx, params)),
  operation("snapshots", "setTarget", "Set your repository's ready snapshot target. Zero pauses claims and replenishment and drains unused snapshots; assigned runs continue. A positive target resumes preparation within the deployment's pool budget.",
    Type.Object({ repoId: text(), target: Type.Integer({ minimum: 0 }) }), "update",
    async (params, ctx) => (await import("./sprite-snapshots")).setSnapshotTarget(ctx, params)),
  operation("snapshots", "retire", "Retire one unused ready repository snapshot you manage. The controller replenishes it if its target remains positive. Assigned and preparing Sprites cannot be retired here.",
    Type.Object({ id: Type.Integer({ minimum: 1 }) }), "delete",
    async ({ id }, ctx) => (await import("./sprite-snapshots")).retireSnapshot(ctx, id)),
  operation("snapshots", "listCheckpoints", "List personal checkpoints in a run's current Sprite generation. These are separate from reusable pool baselines.", Type.Object(target), "read",
    async (params, ctx) => (await import("./sprite-commands")).listRunCheckpoints(ctx, params)),
  operation("snapshots", "checkpoint", "Save a personal filesystem checkpoint of a Sprite run you own. Pause writers first for consistency. This may contain run credentials and is never promoted to the shared pool. Restoration of active agent runners is not supported.",
    Type.Object({ ...target, comment: Type.Optional(Type.String({ maxLength: 1000 })) }), "create",
    async (params, ctx) => (await import("./sprite-commands")).checkpointRun(ctx, params)),
  operation("sprites", "list", "List available Sprite runs owned by you, including generation and working directory. Use these IDs for remote commands; credentials stay on the control plane.", Type.Object({}), "read",
    async (_, ctx) => (await import("./sprite-commands")).listAgentSprites(ctx)),
  operation("sprites", "exec", "Execute a short shell command remotely in an owned Sprite. Returns commandId, status, exit code and bounded output. For installs/builds use startCommand then commandStatus. A timeout may leave the remote outcome unknown; inspect the commandId before retrying.",
    Type.Object({ ...command, timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })) }), "execute",
    async (params, ctx) => (await import("./sprite-commands")).execSpriteCommand(ctx, params)),
  operation("sprites", "startCommand", "Launch a remote background shell command with a VM-enforced timeout (default 600 seconds, maximum 3600). Supply a UUID commandId for safe launch retries; inspect commandStatus in a later CodeAct call. Jobs end when the Sprite is deleted and may continue across tool disconnects.",
    Type.Object({ ...command, timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })) }), "execute",
    async (params, ctx) => (await import("./sprite-commands")).startSpriteCommand(ctx, params)),
  operation("sprites", "commandStatus", "Read a remote command's status, exit code and tail of stdout/stderr (16000 bytes each). Revalidates run ownership and generation. Unknown is not success and should be investigated before retrying.",
    Type.Object({ ...target, commandId: text() }), "read",
    async (params, ctx) => (await import("./sprite-commands")).spriteCommandStatus(ctx, params)),
] satisfies OperationDescriptor[];

export const SPRITE_TOOLS = SPRITE_API_DESCRIPTORS.map(({ tool }) => tool);
