// lib/extensions/planning.ts
//
// Gate tools and interceptor for the planning-agent flow. Instantiated per
// turn with the run context (runId, current planningStage).
//
// Registers three tools that only the planning persona should use:
//   propose_spec          — valid in gathering / spec_review
//   commit_spec_as_plan   — valid only in building_plan
//   propose_implementation_plan — valid in building_plan / plan_review
//
// One interceptToolCall enforces the gates hard:
//   - task_orch__create_plan is always denied (use commit_spec_as_plan instead)
//   - task_orch__create_task / update_task / transition_task are denied unless
//     stage is committing or done
//   - each gate tool is denied outside its valid stages
//
// EXECUTION MODEL: the tool bodies live in PLANNING_TOOLS (server-executable
// registry entries, resolved by lib/worker/server-tools) and read/write
// orchestrator state server-side — workers hold no database access. The
// factory registers transport-backed wrappers and mirrors the stage
// transitions locally after a successful call so the interceptor's gates see
// within-turn stage changes without a round-trip.

import { Type } from "typebox";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { agentMessages, agentSessions } from "@/db/schema";
import * as repo from "../repo";
import type { PlanFull } from "../types";
import type { OrchestratorTool, OrchestratorToolResult } from "../orchestrator-tools";
import { runTransport } from "@/lib/worker";
import type { ExtensionFactory } from "./types";
import type { RunRow } from "../runs";

export type PlanningStage = repo.PlanningStage;

export interface PlanningExtensionOptions {
  runId: number;
  run: RunRow;
}

const ok = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
});
const errResult = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/** Scan the message log (newest first) for the latest propose_spec tool_use
 *  and return its spec_markdown. Returns null if not found. */
async function findLatestSpecMarkdown(runId: number): Promise<string | null> {
  const rows = await db
    .select({ role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(eq(agentMessages.runId, runId))
    .orderBy(desc(agentMessages.id));

  for (const row of rows) {
    if (row.role !== "agent") continue;
    let blocks: unknown[];
    try {
      blocks = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      // On the Claude backend, tool_use blocks are persisted verbatim with the
      // SDK-namespaced MCP name (`mcp__task_orch__propose_spec`); on pi they use
      // the bare name. Match either by accepting the `__propose_spec` suffix.
      if (
        block !== null &&
        typeof block === "object" &&
        (block as any).type === "tool_use" &&
        ((block as any).name === "propose_spec" ||
          String((block as any).name).endsWith("__propose_spec"))
      ) {
        const md = (block as any).input?.spec_markdown;
        if (typeof md === "string") return md;
      }
    }
  }
  return null;
}

/** Server-side view of the fields the planning tools key on. */
async function planningRunFields(
  runId: number
): Promise<{ stage: PlanningStage; title: string | null; repoId: string | null } | null> {
  const row = (
    await db
      .select({
        planningStage: agentSessions.planningStage,
        title: agentSessions.title,
        repoId: agentSessions.repoId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, runId))
  )[0];
  if (!row) return null;
  return {
    stage: (row.planningStage as PlanningStage | null) ?? "gathering",
    title: row.title,
    repoId: row.repoId,
  };
}

// ────────────────────────────────────────
// Server-executable tool registry
// ────────────────────────────────────────

export const PLANNING_TOOLS: OrchestratorTool[] = [
  {
    name: "propose_spec",
    label: "Propose Spec",
    description:
      "Present the drafted spec to the user for review. Valid in gathering and spec_review stages. " +
      "After calling this, stop and wait — do not create the plan until the user approves.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: "Short title for the spec / plan." }),
      spec_markdown: Type.String({
        minLength: 1,
        description: "Full spec in Markdown. Becomes the plan body on approval.",
      }),
      open_questions: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional questions still open for the user to answer.",
        })
      ),
    }),
    execute: async (_params, ctx) => {
      if (!ctx.runId) return errResult("propose_spec needs a run context.");
      const fields = await planningRunFields(ctx.runId);
      if (!fields) return errResult(`Run ${ctx.runId} not found.`);
      // Advance gathering → spec_review (stays spec_review on re-propose).
      if (fields.stage === "gathering") await repo.setPlanningStage(ctx.runId, "spec_review");
      return ok(
        "Spec shown to the user for review. Stop now — do not create the plan " +
          "until they approve (the approve action advances the stage to building_plan)."
      );
    },
  },

  {
    name: "commit_spec_as_plan",
    label: "Commit Spec as Plan",
    description:
      "Save the approved spec as a draft plan (body = spec markdown). Valid only in building_plan stage. " +
      "Returns the new plan id. Call propose_implementation_plan immediately after.",
    parameters: Type.Object({
      title: Type.Optional(
        Type.String({ description: "Plan title. Defaults to the title from propose_spec." })
      ),
    }),
    execute: async (params: { title?: string }, ctx) => {
      if (!ctx.runId) return errResult("commit_spec_as_plan needs a run context.");
      const fields = await planningRunFields(ctx.runId);
      if (!fields) return errResult(`Run ${ctx.runId} not found.`);
      const specMarkdown = await findLatestSpecMarkdown(ctx.runId);
      if (!specMarkdown) {
        return errResult(
          "Error: no propose_spec call found in message history — cannot determine spec body."
        );
      }

      // Derive title from params or the run title.
      const title = params.title?.trim() || fields.title || "Untitled Plan";
      const repoIds = fields.repoId ? [fields.repoId] : undefined;

      let plan: PlanFull;
      try {
        plan = await repo.createPlan({ title, body: specMarkdown, state: "draft", repoIds });
      } catch (err) {
        return errResult(
          `Error creating plan: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Write the new plan id onto the run row so orchestrator tools default to it.
      await db
        .update(agentSessions)
        .set({ planId: plan.id })
        .where(eq(agentSessions.id, ctx.runId));

      return ok(
        `Created draft plan ${plan.id}: "${plan.title}". Now call propose_implementation_plan with the task breakdown.`
      );
    },
  },

  {
    name: "propose_implementation_plan",
    label: "Propose Implementation Plan",
    description:
      "Present the proposed task breakdown to the user for review. Valid in building_plan and plan_review stages. " +
      "After calling this, stop — do not create tasks until the user approves.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          title: Type.String({ minLength: 1 }),
          body: Type.String({ description: "Task description / context." }),
          criteria: Type.Array(Type.String(), {
            description: "Acceptance criteria (2–4 items).",
          }),
          dependencies: Type.Optional(
            Type.Array(Type.String(), {
              description: "Task titles this task depends on.",
            })
          ),
          estimate: Type.Optional(
            Type.String({ description: "Rough size estimate (e.g. S / M / L / XL)." })
          ),
        }),
        { minItems: 1 }
      ),
    }),
    execute: async (_params, ctx) => {
      if (!ctx.runId) return errResult("propose_implementation_plan needs a run context.");
      const fields = await planningRunFields(ctx.runId);
      if (!fields) return errResult(`Run ${ctx.runId} not found.`);
      // Advance building_plan → plan_review (stays plan_review on re-propose).
      if (fields.stage === "building_plan") {
        await repo.setPlanningStage(ctx.runId, "plan_review");
      }
      return ok(
        "Implementation plan shown to the user for review. Stop now — do not create tasks " +
          "until they approve (the approve action advances the stage to committing)."
      );
    },
  },
];

// ────────────────────────────────────────
// Extension factory (transport-backed wrappers + hard gates)
// ────────────────────────────────────────

export const planningExtension =
  (opts: PlanningExtensionOptions): ExtensionFactory =>
  (reg) => {
    // Mutable stage so within-turn changes are visible to the interceptor.
    // Initialized from the run row at mount; mirrored locally after each
    // successful gate tool (the server advanced the persisted stage).
    let stage: PlanningStage =
      (opts.run.planningStage as PlanningStage | null) ?? "gathering";

    for (const tool of PLANNING_TOOLS) {
      reg.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, params) => {
          const transport = await runTransport();
          const r = await transport.callTool(opts.runId, tool.name, params, { author: "agent" });
          if (!r.isError) {
            // Mirror the server-side stage transitions for the interceptor.
            if (tool.name === "propose_spec" && stage === "gathering") stage = "spec_review";
            if (tool.name === "propose_implementation_plan" && stage === "building_plan") {
              stage = "plan_review";
            }
          }
          return { content: r.content, details: undefined, isError: r.isError ?? false };
        },
      });
    }

    // ── interceptor: hard gates ───────────────────────────────────────────────
    reg.interceptToolCall((event) => {
      const { toolName } = event;

      // Always deny the generic create_plan in a planning run.
      if (toolName === "task_orch__create_plan") {
        return {
          block: true,
          reason:
            "In a planning run, use commit_spec_as_plan (valid in building_plan stage) " +
            "instead of create_plan directly.",
        };
      }

      // Deny task-write tools until the plan is approved and stage is committing/done.
      if (
        toolName === "task_orch__create_task" ||
        toolName === "task_orch__update_task" ||
        toolName === "task_orch__transition_task"
      ) {
        if (stage !== "committing" && stage !== "done") {
          return {
            block: true,
            reason:
              `${toolName} is not allowed until the implementation plan is approved. ` +
              `Current stage: ${stage}. ` +
              `Call propose_implementation_plan and wait for the user to approve (stage advances to committing).`,
          };
        }
      }

      // Gate propose_spec to gathering and spec_review.
      if (toolName === "propose_spec") {
        if (stage !== "gathering" && stage !== "spec_review") {
          return {
            block: true,
            reason:
              `propose_spec is only valid in gathering or spec_review stages. Current stage: ${stage}. ` +
              `In building_plan, call commit_spec_as_plan then propose_implementation_plan instead.`,
          };
        }
      }

      // Gate commit_spec_as_plan to building_plan.
      if (toolName === "commit_spec_as_plan") {
        if (stage !== "building_plan") {
          return {
            block: true,
            reason:
              `commit_spec_as_plan is only valid in building_plan stage. Current stage: ${stage}. ` +
              `Wait for the user to approve the spec (approve_spec action advances to building_plan).`,
          };
        }
      }

      // Gate propose_implementation_plan to building_plan and plan_review.
      if (toolName === "propose_implementation_plan") {
        if (stage !== "building_plan" && stage !== "plan_review") {
          return {
            block: true,
            reason:
              `propose_implementation_plan is only valid in building_plan or plan_review stages. ` +
              `Current stage: ${stage}. ` +
              `Call commit_spec_as_plan first (requires building_plan stage).`,
          };
        }
      }
    });
  };
