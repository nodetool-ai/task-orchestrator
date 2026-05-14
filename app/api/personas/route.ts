import { NextResponse } from "next/server";
import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export async function GET() {
  const personas = repo.listPersonas().map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    modelProvider: p.modelProvider,
    modelId: p.modelId,
    thinkingLevel: p.thinkingLevel,
    toolsProfile: p.toolsProfile,
    skillPaths: JSON.parse(p.skillPaths) as string[],
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  }));
  return NextResponse.json({ personas });
}
