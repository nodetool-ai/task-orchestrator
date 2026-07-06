// lib/extensions/env-scrub.ts
//
// Tier 0 secret scrubbing (see lib/agent-backend/env-scrub.ts for the full
// incident rationale): strips DATABASE_URL and every model-provider
// credential from the shell environment of every bash tool call an agent
// issues, on BOTH backends. Registered identically to lib/extensions/sandbox.ts
// via the shared ToolCallInterceptor seam (lib/agent-backend/collect.ts
// `runInterceptors`), so it applies whether the call reaches us through
// Claude's PreToolUse hook or pi's `tool_call` event.
//
// Mechanism: prepend `unset A B C ...\n` to the bash command string. `unset`
// removes the vars from the *shell's* environment before the rest of the
// command runs, so every child process the untrusted command spawns (npm
// install scripts, git, curl, a nested interpreter) inherits an environment
// without them too — not just the top-level shell.

import type { ExtensionFactory } from "./types";
import { bashUnsetPrefix } from "../agent-backend/env-scrub";

export const envScrubFactory: ExtensionFactory = (reg) => {
  reg.interceptToolCall((event) => {
    if (event.toolName === "bash" && typeof event.input?.command === "string") {
      return {
        input: {
          command: bashUnsetPrefix() + event.input.command,
        },
      };
    }
  });
};
