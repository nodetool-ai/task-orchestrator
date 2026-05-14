import * as repo from "@/lib/repo";

export const dynamic = "force-dynamic";

export default function PersonasPage() {
  const personas = repo.listPersonas();

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Personas</h1>
          <p className="text-sm text-muted-foreground">
            Personas bundle (system prompt, model, tools, skills, budgets) per role.
            Edit <code>lib/personas/*.ts</code> and restart to change them.
          </p>
        </div>
      </header>

      {personas.length === 0 ? (
        <p className="text-sm text-muted-foreground">No personas configured.</p>
      ) : (
        <div className="space-y-4">
          {personas.map((p) => {
            const skillPaths = JSON.parse(p.skillPaths) as string[];
            return (
              <div
                key={p.id}
                className="rounded-lg border border-border/60 bg-card/30 p-4 space-y-3"
              >
                <div className="flex items-baseline gap-3">
                  <h2 className="text-lg font-semibold">{p.name}</h2>
                  <code className="text-xs text-muted-foreground">{p.id}</code>
                </div>
                {p.description && (
                  <p className="text-sm text-muted-foreground">{p.description}</p>
                )}
                <dl className="grid grid-cols-[8rem_1fr] gap-1 text-sm">
                  <dt className="text-muted-foreground">Model</dt>
                  <dd className="font-mono text-xs">
                    {p.modelProvider}/{p.modelId}
                    {p.thinkingLevel ? ` (thinking: ${p.thinkingLevel})` : ""}
                  </dd>
                  <dt className="text-muted-foreground">Tools</dt>
                  <dd className="font-mono text-xs">{p.toolsProfile}</dd>
                  <dt className="text-muted-foreground">Skills</dt>
                  <dd>
                    {skillPaths.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="space-y-0.5">
                        {skillPaths.map((s) => (
                          <div key={s} className="font-mono text-xs">
                            {s}
                          </div>
                        ))}
                      </div>
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Budget</dt>
                  <dd className="text-xs">
                    turns: {p.budgetMaxTurns ?? "—"}, seconds:{" "}
                    {p.budgetMaxSeconds ?? "—"}
                  </dd>
                </dl>
                <details className="group">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    System prompt
                  </summary>
                  <pre className="mt-3 whitespace-pre-wrap rounded bg-secondary/50 p-3 text-[11px] overflow-x-auto">
                    {p.systemPrompt}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
