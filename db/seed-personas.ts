import { PERSONAS } from "@/lib/personas";
import * as repo from "@/lib/repo";

export function seedPersonas(): void {
  for (const p of PERSONAS) {
    repo.upsertPersona({
      id: p.id,
      name: p.name,
      description: p.description,
      systemPrompt: p.systemPrompt,
      modelProvider: p.model.provider,
      modelId: p.model.id,
      thinkingLevel: p.thinkingLevel ?? null,
      toolsProfile: p.toolsProfile,
      skillPaths: p.skillPaths,
      budgetMaxTurns: p.budget?.maxTurns ?? null,
      budgetMaxSeconds: p.budget?.maxSeconds ?? null,
    });
  }
}
