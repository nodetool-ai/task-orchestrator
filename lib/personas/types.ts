export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: { provider: string; id: string };
  thinkingLevel?: "low" | "medium" | "high";
  toolsProfile: string;
  skillPaths: string[];
  budget?: { maxTurns?: number; maxSeconds?: number };
}
