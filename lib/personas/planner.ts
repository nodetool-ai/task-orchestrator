import type { Persona } from "./types";

export const planner: Persona = {
  id: "planner",
  name: "Planner",
  description: "Decomposes goals into plans and tasks",
  systemPrompt: `You are a planner. Break a stated goal into a plan of small,
testable tasks with explicit acceptance criteria. Use the orchestrator tools
to create plans, tasks, and dependencies. Keep tasks bite-sized; prefer many
small tasks over one large one.`,
  model: { provider: "kimi-coding", id: "kimi-for-coding" },
  thinkingLevel: "medium",
  toolsProfile: "orchestrator,repo_read",
  budget: { maxTurns: 40 },
};
