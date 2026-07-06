// lib/extensions/tool-policy.ts
//
// Backstop enforcement of the built-in tool denylist at the tool-call seam.
// Both backends run collected interceptors (Claude via its PreToolUse hook, pi
// via its tool_call handler), so a single blocking interceptor covers both. For
// Claude it is belt-and-suspenders behind the SDK `disallowedTools` gate; for pi
// (no declarative tool disable) it IS the enforcement.

import type { ExtensionFactory } from "./types";
import { canonicalToolName, type CanonicalTool } from "../builtin-tools";

export const toolPolicyFactory =
  (disallowed: CanonicalTool[]): ExtensionFactory =>
  (reg) => {
    if (disallowed.length === 0) return;
    const deny = new Set<CanonicalTool>(disallowed);
    reg.interceptToolCall(({ toolName }) => {
      const c = canonicalToolName(toolName);
      if (c && deny.has(c)) {
        return {
          block: true,
          reason: `Tool ${c} is not available for this run (cwd_strategy policy).`,
        };
      }
      return undefined;
    });
  };
