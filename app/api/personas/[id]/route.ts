import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { PERSONAS } from "@/lib/personas";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

const PatchBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  systemPrompt: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  thinkingLevel: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  backend: z.enum(["pi", "claude"]).nullable().optional(),
  toolsProfile: z.string().min(1).optional(),
  budgetMaxTurns: z.number().int().positive().nullable().optional(),
  budgetMaxSeconds: z.number().int().positive().nullable().optional(),
});

const PostBody = z.object({
  action: z.literal("reset"),
});

function serialize(p: Awaited<ReturnType<typeof repo.getPersona>> & {}) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    modelProvider: p.modelProvider,
    modelId: p.modelId,
    thinkingLevel: p.thinkingLevel,
    toolsProfile: p.toolsProfile,
    backend: p.backend,
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const existing = await repo.getPersona(id);
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
    modelProvider: parsed.data.modelProvider ?? existing.modelProvider,
    modelId: parsed.data.modelId ?? existing.modelId,
    thinkingLevel:
      parsed.data.thinkingLevel !== undefined
        ? parsed.data.thinkingLevel
        : existing.thinkingLevel,
    backend:
      (parsed.data.backend !== undefined
        ? parsed.data.backend
        : existing.backend) as "pi" | "claude" | null,
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
  await repo.upsertPersona(merged);
  const next = (await repo.getPersona(id))!;
  return NextResponse.json({ persona: serialize(next) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const parsed = PostBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }

  const defaults = PERSONAS.find((p) => p.id === id);
  if (!defaults) {
    return NextResponse.json({ error: "No hardcoded default for persona" }, { status: 404 });
  }

  await repo.upsertPersona({
    id: defaults.id,
    name: defaults.name,
    description: defaults.description,
    systemPrompt: defaults.systemPrompt,
    modelProvider: defaults.modelProvider ?? "anthropic",
    modelId: defaults.modelId ?? "claude-sonnet-4-6",
    thinkingLevel: defaults.thinkingLevel ?? null,
    toolsProfile: defaults.toolsProfile,
    backend: defaults.backend ?? null,
    skillPaths: [],
    budgetMaxTurns: defaults.budget?.maxTurns ?? null,
    budgetMaxSeconds: defaults.budget?.maxSeconds ?? null,
  });

  const next = (await repo.getPersona(id))!;
  return NextResponse.json({ persona: serialize(next) });
}
