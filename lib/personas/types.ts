// A persona is WHO an agent is: its prompt, its tools, its budget. It never
// carries WHICH engine or model runs it — model, backend and reasoning level
// are per-run choices with deployment defaults behind them (see
// lib/runs.ts create() and migration 0031). One persona therefore runs on any
// engine, and a run's engine is read off the run itself.
export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  toolsProfile: string;
  budget?: { maxTurns?: number; maxSeconds?: number };
}
