import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  systemPrompt: z.string().min(1).optional(),
  thinkingLevel: z.enum(["low", "medium", "high"]).nullable().optional(),
  toolsProfile: z.string().min(1).optional(),
  budgetMaxTurns: z.number().int().positive().nullable().optional(),
  budgetMaxSeconds: z.number().int().positive().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = repo.getPersona(id);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  // Merge: existing values pass through unchanged unless the body sets them.
  const merged = {
    id: existing.id,
    name: parsed.data.name ?? existing.name,
    description:
      parsed.data.description !== undefined
        ? parsed.data.description
        : existing.description,
    systemPrompt: parsed.data.systemPrompt ?? existing.systemPrompt,
    thinkingLevel:
      parsed.data.thinkingLevel !== undefined
        ? parsed.data.thinkingLevel
        : existing.thinkingLevel,
    toolsProfile: parsed.data.toolsProfile ?? existing.toolsProfile,
    skillPaths: [],
    budgetMaxTurns:
      parsed.data.budgetMaxTurns !== undefined
        ? parsed.data.budgetMaxTurns
        : existing.budgetMaxTurns,
    budgetMaxSeconds:
      parsed.data.budgetMaxSeconds !== undefined
        ? parsed.data.budgetMaxSeconds
        : existing.budgetMaxSeconds,
  };
  repo.upsertPersona(merged);
  const next = repo.getPersona(id)!;
  return NextResponse.json({
    persona: {
      id: next.id,
      name: next.name,
      description: next.description,
      systemPrompt: next.systemPrompt,
      thinkingLevel: next.thinkingLevel,
      toolsProfile: next.toolsProfile,
      budgetMaxTurns: next.budgetMaxTurns,
      budgetMaxSeconds: next.budgetMaxSeconds,
    },
  });
}
