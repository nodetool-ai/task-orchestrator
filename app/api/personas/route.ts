import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
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
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  };
}
