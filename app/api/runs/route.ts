import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import * as runs from "@/lib/runs";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

// Body shape for POST /api/runs. Mirrors runs.CreateRunInput but with the
// hot-path fields exposed: the task page modal sends goal/toolsProfile/
// cwdStrategy/budget/initialPrompt/taskId straight through.
const createRunSchema = z.object({
  goal: z.string().min(1).optional(),
  toolsProfile: z.string().min(1).optional(),
  cwdStrategy: z.enum(["worktree", "worktree_at_pr", "repo", "none"]).optional(),
  repoId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  planId: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  parentRunId: z.number().int().positive().nullable().optional(),
  model: z.string().nullable().optional(),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  title: z.string().nullable().optional(),
  baseBranch: z.string().optional(),
  initialPrompt: z.string().nullable().optional(),
  personaId: z.string().min(1).optional(),
  defer: z.boolean().optional(),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxUsd: z.number().positive().optional(),
      maxSeconds: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
});

async function userId(): Promise<number | null> {
  const session = await auth();
  const id = session?.user?.id;
  return id ? Number(id) : null;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const input = createRunSchema.parse(raw);
    const uid = await userId();
    const run = runs.create({
      goal: input.goal ?? "<implement>",
      toolsProfile: input.toolsProfile,
      cwdStrategy: input.cwdStrategy,
      repoId: input.repoId ?? undefined,
      taskId: input.taskId ?? undefined,
      planId: input.planId ?? undefined,
      prUrl: input.prUrl ?? undefined,
      parentRunId: input.parentRunId ?? undefined,
      model: input.model ?? undefined,
      thinkingLevel: input.thinkingLevel ?? undefined,
      title: input.title ?? undefined,
      baseBranch: input.baseBranch,
      initialPrompt: input.initialPrompt ?? undefined,
      personaId: input.personaId,
      defer: input.defer,
      budget: input.budget ?? undefined,
      userId: uid,
    });
    return NextResponse.json(run, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
