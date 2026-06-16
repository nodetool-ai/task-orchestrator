// Shared test helper: a neutral BackendRegistrar stub that captures everything
// an extension registers, plus small helpers to fire the captured hooks. Mirrors
// the real registrar surface (lib/agent-backend/types.ts).

import type {
  AmbientSkill,
  BackendRegistrar,
  NeutralTool,
  ToolCallDecision,
  ToolCallEvent,
  ToolCallInterceptor,
} from "../../lib/agent-backend/types";

export function makeRegistrar() {
  const tools = new Map<string, NeutralTool>();
  const systemPromptFns: Array<(base: string) => string | Promise<string>> = [];
  const interceptors: ToolCallInterceptor[] = [];
  const agentStartFns: Array<(ctx: { abort: () => void }) => void> = [];
  const skills: AmbientSkill[] = [];

  const reg: BackendRegistrar = {
    registerTool: (t) => tools.set(t.name, t),
    transformSystemPrompt: (fn) => systemPromptFns.push(fn),
    interceptToolCall: (fn) => interceptors.push(fn),
    onAgentStart: (fn) => agentStartFns.push(fn),
    addAmbientSkill: (s) => skills.push(s),
  };

  return {
    reg,
    tools,
    systemPromptFns,
    interceptors,
    agentStartFns,
    skills,
    /** Run the first registered tool-call interceptor against an event. */
    fireToolCall(event: ToolCallEvent): Promise<ToolCallDecision> | ToolCallDecision {
      if (interceptors.length === 0) throw new Error("no tool-call interceptor registered");
      return interceptors[0](event);
    },
    /** Compose all registered system-prompt transforms over a base prompt. */
    async composePrompt(base: string): Promise<string> {
      let s = base;
      for (const fn of systemPromptFns) s = await fn(s);
      return s;
    },
  };
}
