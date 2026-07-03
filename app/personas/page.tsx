import * as repo from "@/lib/repo";
import { PersonaEditor, type PersonaDto } from "@/components/persona-editor";
import { EmptyState } from "@/components/ui/empty-state";

export const dynamic = "force-dynamic";

export default async function PersonasPage() {
  const personas: PersonaDto[] = (await repo.listPersonas()).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    systemPrompt: p.systemPrompt,
    thinkingLevel: p.thinkingLevel,
    toolsProfile: p.toolsProfile,
    budgetMaxTurns: p.budgetMaxTurns,
    budgetMaxSeconds: p.budgetMaxSeconds,
  }));

  return (
    <main style={{ padding: "20px 20px 80px", maxWidth: 1480, margin: "0 auto" }} className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Personas</h1>
        <p className="text-sm text-muted-foreground">
          Each persona bundles a system prompt, tools profile, and budget
          defaults. The model is chosen per-run when you launch the agent.
          Skills are loaded automatically from the project
          (<code>.pi/skills/</code>, <code>.agents/skills/</code>) — no
          per-persona setup needed. Edits saved here override the seed in{" "}
          <code>lib/personas/*.ts</code>.
        </p>
      </header>

      {personas.length === 0 ? (
        <EmptyState>No personas configured.</EmptyState>
      ) : (
        <ul className="space-y-4">
          {personas.map((p) => (
            <PersonaEditor key={p.id} persona={p} />
          ))}
        </ul>
      )}
    </main>
  );
}
