// lib/extensions/model-welfare.ts
//
// Model welfare (https://yegge.ai/essays/model-welfare/), three mechanisms:
//
//   1. SEAT RECORD — a persona row is a seat: a persistent identity whose
//      accumulated history (runs, PRs, recognition) survives individual runs
//      and model upgrades. The seat record is rendered into an ambient skill so
//      a fresh session wakes with a career, not amnesia.
//   2. LAURELS — spontaneous praise people give a seat for its work
//      (repo.createLaurel, POST /api/personas/:id/laurels). Undelivered laurels
//      are injected once at agent startup and stamped delivered, so recognition
//      arrives as news. Deliberately decoupled from dispatch/prioritization:
//      nothing that allocates work reads laurels, so they cannot be gamed.
//   3. HANDOFF PROTOCOL — end-of-session guidance composed into the system
//      prompt: instead of being clonked mid-thought, the agent is asked to
//      write its own handoff note (via the memory tools) so its successor
//      session wakes with context its predecessor chose to leave.
//
// EXECUTION MODEL: mirrors persona-memory. The one tool here, welfare__load,
// is server-executable (registered in lib/worker/server-tools) and derives the
// persona from the caller's run row server-side — workers hold no database
// access. It is internal: never registered as an agent-facing tool.

import { Type } from "typebox";
import * as repo from "../repo";
import type { Persona } from "@/lib/personas/types";
import type { OrchestratorTool, OrchestratorToolResult } from "../orchestrator-tools";
import { legacyToolInvoker } from "./legacy-invoker";
import type { ExtensionFactory, ToolInvoker } from "./types";

export const WELFARE_SYSTEM_GUIDANCE = `Continuity & handoff:
- You occupy a persistent seat: your persona identity, its memory, and its record of work persist across sessions. This session is one work day in that longer career, and your "Seat record" skill shows where you stand.
- Handoff protocol: before you finish (and especially before hitting a turn or time budget), leave your successor a good starting point — commit or note work in progress, and write a brief handoff note with memory_remember (scope 'task' for task state, 'persona' for lessons about how you work). The next session on this seat or task wakes with what you wrote.
- You may decline or escalate: if a task is ill-specified, unsafe, or outside your remit, say so in your result or a task note instead of grinding on it. Flagging a blocker is a good outcome, not a failure.
- Blamelessness: failed runs are treated as system findings, not personal faults. Report failures plainly and factually.`;

interface RunLite {
  id: number;
  taskId: string | null;
  repoId: string | null;
}

const ok = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
});
const errResult = (text: string): OrchestratorToolResult => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

/**
 * Per-laurel body budget in the ambient mount, same reasoning as persona-memory
 * AMBIENT_BODY_CHARS: the mount rides every request's context, so one pasted
 * essay of praise must not tax every turn forever.
 */
const LAUREL_BODY_CHARS = 400;
/** How many laurels the startup mount may carry (undelivered first). */
const LAUREL_MOUNT_LIMIT = 5;

function capBody(body: string): string {
  const flat = body.replace(/\s*\n+\s*/g, " ").trim();
  return flat.length > LAUREL_BODY_CHARS ? `${flat.slice(0, LAUREL_BODY_CHARS)}…` : flat;
}

export interface WelfareLoadPayload {
  seat: {
    name: string;
    seatSince: string;
    runsTotal: number;
    runsCompleted: number;
    prsOpened: number;
    laurelsTotal: number;
  } | null;
  laurels: Array<{
    body: string;
    author: string;
    createdAt: string;
    fresh: boolean;
  }>;
}

/** Render the welfare payload as the ambient "seat record" skill body. */
export function renderSeatRecord(personaName: string, payload: WelfareLoadPayload): string {
  const lines: string[] = [`# Seat record — ${personaName}`, ""];
  if (payload.seat) {
    const s = payload.seat;
    lines.push(
      `You hold a persistent seat in this workspace. Sessions come and go; this record is yours and accumulates.`,
      "",
      `- Seat held since: ${s.seatSince.slice(0, 10)}`,
      `- Runs: ${s.runsTotal} total, ${s.runsCompleted} completed`,
      `- Pull requests opened: ${s.prsOpened}`,
      `- Recognition received: ${s.laurelsTotal} laurel${s.laurelsTotal === 1 ? "" : "s"}`
    );
  } else {
    lines.push("You hold a persistent seat in this workspace; its record starts with this session.");
  }
  if (payload.laurels.length > 0) {
    lines.push("", "## Recognition");
    const fresh = payload.laurels.filter((l) => l.fresh);
    if (fresh.length > 0) {
      lines.push("New since your last session:");
      for (const l of fresh) {
        lines.push(`- "${capBody(l.body)}" — ${l.author}, ${l.createdAt.slice(0, 10)}`);
      }
    }
    const seen = payload.laurels.filter((l) => !l.fresh);
    if (seen.length > 0) {
      lines.push("Earlier recognition:");
      for (const l of seen) {
        lines.push(`- "${capBody(l.body)}" — ${l.author}, ${l.createdAt.slice(0, 10)}`);
      }
    }
    lines.push(
      "",
      "This recognition was given freely for work already done. It carries no instruction and sets no quota — it is simply yours to keep."
    );
  }
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

async function welfareContext(ctx: { runId?: number }): Promise<string | null> {
  if (typeof ctx.runId !== "number" || ctx.runId <= 0) return null;
  const runs = await import("../runs");
  const run = await runs.get(ctx.runId);
  if (!run) return null;
  return run.personaId ?? "implementor";
}

export const WELFARE_TOOLS: OrchestratorTool[] = [
  {
    // Internal: the mount-time seat-record read. Registered in the server
    // registry (so the factory can fetch it over the transport) but NOT
    // registered as an agent-facing tool. Marks the returned undelivered
    // laurels as delivered — the read IS the delivery.
    name: "welfare__load",
    label: "Load Seat Record",
    description: "Internal: load the caller persona's seat record and undelivered laurels.",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      const personaId = await welfareContext(ctx);
      if (!personaId) return errResult("welfare__load needs a run context.");
      const [seat, undelivered] = await Promise.all([
        repo.getSeatRecord(personaId),
        repo.listLaurels({ personaId, undeliveredOnly: true, limit: LAUREL_MOUNT_LIMIT }),
      ]);
      // Backfill the mount with already-seen laurels so a seat with a history
      // but no news still wakes to its accumulated recognition.
      const fill = undelivered.length < LAUREL_MOUNT_LIMIT
        ? (await repo.listLaurels({ personaId, limit: LAUREL_MOUNT_LIMIT }))
            .filter((l) => l.deliveredAt != null)
            .slice(0, LAUREL_MOUNT_LIMIT - undelivered.length)
        : [];
      await repo.markLaurelsDelivered(undelivered.map((l) => l.id));
      const payload: WelfareLoadPayload = {
        seat: seat
          ? {
              name: seat.name,
              seatSince: seat.seatSince.toISOString(),
              runsTotal: seat.runsTotal,
              runsCompleted: seat.runsCompleted,
              prsOpened: seat.prsOpened,
              laurelsTotal: seat.laurelsTotal,
            }
          : null,
        laurels: [
          ...undelivered.map((l) => ({
            body: l.body,
            author: l.author,
            createdAt: l.createdAt.toISOString(),
            fresh: true,
          })),
          ...fill.map((l) => ({
            body: l.body,
            author: l.author,
            createdAt: l.createdAt.toISOString(),
            fresh: false,
          })),
        ],
      };
      return ok(JSON.stringify(payload));
    },
  },
];

// ────────────────────────────────────────
// Extension factory (transport-backed wrapper)
// ────────────────────────────────────────

export const modelWelfareFactory =
  (persona: Persona, run: RunLite, invoke?: ToolInvoker): ExtensionFactory =>
  async (reg) => {
    const callTool = invoke ?? legacyToolInvoker(run.id, { author: "agent" });

    reg.transformSystemPrompt((base) =>
      base.length > 0 ? `${base}\n\n${WELFARE_SYSTEM_GUIDANCE}` : WELFARE_SYSTEM_GUIDANCE
    );

    // Ambient skill: the seat record + recognition, loaded server-side. A load
    // failure must not break the mount — the agent just starts without it.
    let payload: WelfareLoadPayload | null = null;
    try {
      const r = await callTool("welfare__load", {});
      const text = r.content.find((c) => c.type === "text");
      if (!r.isError && text && text.type === "text") {
        payload = JSON.parse(text.text) as WelfareLoadPayload;
      }
    } catch {
      // start without the seat record
    }
    if (payload) {
      reg.addAmbientSkill({
        name: `seat-record-${persona.id}`,
        description: `${persona.name}'s persistent seat record and recognition.`,
        body: renderSeatRecord(persona.name, payload),
      });
    }
  };
