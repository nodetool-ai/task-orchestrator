import { NextResponse, type NextRequest } from "next/server";
import { requireBearer } from "@/lib/api-auth";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireBearer(req);
  if (denied) return denied;
  const personas = (await repo.listPersonas()).map(serialize);
  return NextResponse.json({ personas });
}

function serialize(p: Awaited<ReturnType<typeof repo.listPersonas>>[number]) {
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
