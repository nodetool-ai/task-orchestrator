export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  toolsProfile: string;
  budget?: { maxTurns?: number; maxSeconds?: number };
}
