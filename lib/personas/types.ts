export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: "low" | "medium" | "high" | "xhigh";
  toolsProfile: string;
  backend?: "pi" | "claude";
  budget?: { maxTurns?: number; maxSeconds?: number };
}
