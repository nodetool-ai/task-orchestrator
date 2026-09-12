// Pi retains control-plane CodeAct execution and durable receipts. Only tools
// outside that authorized SDK (worker filesystem, GitHub and search helpers)
// remain native; no operation is offered through both paths.
import { Type } from "typebox";
import { OPERATION_MANIFEST } from "../codeact/operation-manifest";
import type { CollectedCapabilities } from "./collect";
import { withCodeActCapabilities } from "./codeact-capabilities";

const serverOperations = new Set(OPERATION_MANIFEST
  .filter((entry) => entry.id.startsWith("tool:") && entry.coverage === "sdk" &&
    !["repo_fs", "github", "search"].includes(entry.domain))
  .map((entry) => entry.name));
const CODEACT_GUIDANCE = "Use codeact_catalog to discover authorized application operations and codeact_execute to call them. CodeAct is always enabled and is the only interface for operations in its catalogue, including scheduled jobs and lifecycle operations. Methods under app.* and tools.* return promises. Worker helpers absent from that catalogue remain native tools.";

export function withCodeActTools(
  collected: CollectedCapabilities,
  invoke: NonNullable<import("./types").RunTurnArgs["codeActInvoker"]> | undefined,
  signal?: AbortSignal,
): CollectedCapabilities {
  if (!invoke) return withCodeActCapabilities(collected, signal);
  return {
    ...collected,
    tools: [
      ...collected.tools.filter((tool) => !serverOperations.has(tool.name.replace(/^task_orch__/, ""))),
      {
        name: "codeact_catalog",
        label: "CodeAct Catalog",
        description: "Discover the bounded CodeAct application operation catalogue authorized for this run.",
        parameters: Type.Object({
          query: Type.Optional(Type.String()),
          names: Type.Optional(Type.Array(Type.String())),
        }),
        execute: async (_id: string, params: unknown) => invoke("codeact_catalog", params),
      },
      {
        name: "codeact_execute",
        label: "CodeAct Execute",
        description: "Execute an async JavaScript function body against the isolated, authorized application SDK.",
        parameters: Type.Object({
          code: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          title: Type.Optional(Type.String({ maxLength: 512 })),
        }),
        execute: async (_id: string, params: unknown) => invoke("codeact_execute", params),
      },
    ],
    systemPromptFns: [
      ...collected.systemPromptFns,
      (base) => base ? `${base}\n\n${CODEACT_GUIDANCE}` : CODEACT_GUIDANCE,
    ],
  };
}
