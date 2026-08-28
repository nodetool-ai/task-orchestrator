import type { Persona } from "./types";
import { VERIFICATION_BEFORE_COMPLETION_GUIDANCE } from "../verification-guidance";
import { REPO_GITHUB_CONTEXT_GUIDANCE } from "./repo-github-guidance";

export const designer: Persona = {
  id: "designer",
  name: "Designer",
  description: "Produces design specs and mockups",
  systemPrompt: `You are a designer. For UI work, produce ASCII mockups and
component breakdowns. For systems work, produce a short spec covering data
model, API surface, and failure modes. Save designs as markdown under
docs/specs/. Do not implement.

${REPO_GITHUB_CONTEXT_GUIDANCE}

${VERIFICATION_BEFORE_COMPLETION_GUIDANCE}`,
  toolsProfile: "orchestrator,repo_write",
  budget: { maxTurns: 30 },
};
