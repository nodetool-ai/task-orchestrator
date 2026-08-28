import { PERSONAS } from "@/lib/personas";
import * as repo from "@/lib/repo";

/**
 * Seed personas from lib/personas/*.ts.
 *
 * Default behavior is insert-if-missing: if a persona id already exists in
 * the DB it is left alone. This way edits made through the /personas UI
 * survive `npm run db:seed` and service restarts.
 *
 * Pass `force: true` to upsert (overwrite existing rows from the TS files).
 * Use this when you want to push a code-driven persona definition and
 * discard UI edits.
 */
export async function seedPersonas(opts: { force?: boolean } = {}): Promise<void> {
  const force = opts.force === true;
  for (const p of PERSONAS) {
    if (!force && (await repo.getPersona(p.id))) continue;
    await repo.upsertPersona({
      id: p.id,
      name: p.name,
      description: p.description,
      systemPrompt: p.systemPrompt,
      toolsProfile: p.toolsProfile,
      skillPaths: [],
      budgetMaxTurns: p.budget?.maxTurns ?? null,
      budgetMaxSeconds: p.budget?.maxSeconds ?? null,
    });
  }
}
