import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import * as repo from "@/lib/repo";
import * as runs from "@/lib/runs";
import { buildImplementPrompt, IMPLEMENT_DEFAULT_BUDGET_USD } from "@/lib/run-templates";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Open-or-create the task's single attached run.
//   { seed?: true }  → Agent button: create + kick off the implement turn.
//   { seed: false }  → chat box: create deferred (the user's message is turn 1).
// Returns { runId, created }.
const bodySchema = z
  .object({
    seed: z.boolean().optional(),
    // Honored only when the run is first created (the chat box pickers).
    personaId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  })
  .optional();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const task = await repo.getTask(id);
    if (!task) return errorResponse(new repo.RepoError(`Task ${id} not found`, 404));

    const existing = await repo.resolveAttachedRun(id);
    if (existing) return NextResponse.json({ runId: existing.id, created: false });

    const raw = req.headers.get("content-length") === "0" ? {} : await req.json().catch(() => ({}));
    const { seed = true, personaId, model, thinkingLevel } = bodySchema.parse(raw) ?? {};

    const session = await auth();
    const uid = session?.user?.id ? Number(session.user.id) : null;

    const run = await runs.create({
      goal: "<implement>",
      toolsProfile: "orchestrator,repo_write",
      cwdStrategy: "worktree",
      taskId: id,
      personaId: personaId ?? "implementor",
      model: model ?? undefined,
      thinkingLevel: thinkingLevel ?? undefined,
      userId: uid,
      budget: { maxUsd: IMPLEMENT_DEFAULT_BUDGET_USD },
      // Agent button seeds the implement prompt and kicks the first turn; the
      // chat box defers so the user's own message becomes turn 1.
      initialPrompt: seed ? await buildImplementPrompt(task) : undefined,
      defer: !seed,
    });
    return NextResponse.json({ runId: run.id, created: true }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
