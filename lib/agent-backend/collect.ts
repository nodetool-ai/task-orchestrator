// lib/agent-backend/collect.ts
//
// Run a list of neutral Extensions against a collecting registrar to gather the
// tools/hooks/skills they contribute. Both adapters use this: the pi adapter
// needs the collected skills written to disk before the session scans them, and
// the Claude adapter needs everything up front to build query() options.

import type {
  AmbientSkill,
  BackendRegistrar,
  Extension,
  NeutralTool,
  ToolCallInterceptor,
} from "./types";

export interface CollectedCapabilities {
  tools: NeutralTool[];
  systemPromptFns: Array<(base: string) => string | Promise<string>>;
  interceptors: ToolCallInterceptor[];
  agentStartFns: Array<(ctx: { abort: () => void }) => void>;
  skills: AmbientSkill[];
}

export async function collectExtensions(
  extensions: Extension[]
): Promise<CollectedCapabilities> {
  const collected: CollectedCapabilities = {
    tools: [],
    systemPromptFns: [],
    interceptors: [],
    agentStartFns: [],
    skills: [],
  };

  const reg: BackendRegistrar = {
    registerTool: (t) => collected.tools.push(t),
    transformSystemPrompt: (fn) => collected.systemPromptFns.push(fn),
    interceptToolCall: (fn) => collected.interceptors.push(fn),
    onAgentStart: (fn) => collected.agentStartFns.push(fn),
    addAmbientSkill: (s) => collected.skills.push(s),
  };

  for (const ext of extensions) {
    await ext(reg);
  }
  return collected;
}

/** Compose the registered system-prompt transforms over a base prompt, in
 *  registration order. */
export async function composeSystemPrompt(
  base: string,
  fns: Array<(base: string) => string | Promise<string>>
): Promise<string> {
  let out = base;
  for (const fn of fns) out = await fn(out);
  return out;
}

/**
 * Run the interceptor chain for a single (canonical) tool call. Returns a
 * decision the adapter applies to its SDK: `block` to deny, or the final
 * (possibly mutated) input. Mutations accumulate across interceptors.
 */
export async function runInterceptors(
  interceptors: ToolCallInterceptor[],
  toolName: string,
  input: Record<string, any>
): Promise<{ block: true; reason: string } | { input: Record<string, any> } | null> {
  let current = input;
  let mutated = false;
  for (const fn of interceptors) {
    const decision = await fn({ toolName, input: current });
    if (!decision) continue;
    if ("block" in decision) return { block: true, reason: decision.reason };
    if ("input" in decision) {
      current = { ...current, ...decision.input };
      mutated = true;
    }
  }
  return mutated ? { input: current } : null;
}
