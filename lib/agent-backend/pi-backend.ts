// lib/agent-backend/pi-backend.ts
//
// pi-coding-agent adapter. Wraps the neutral RunTurnArgs into a pi session:
// builds a single pi ExtensionFactory from the collected capabilities, maps pi
// events to RunEnvelope via mapPiEvent, and tags the session-file resume token
// with a "pi:" prefix so it can't be mistaken for a Claude session id.

import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionFactory as PiExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getModel, getProviders, getModels } from "@earendil-works/pi-ai";

import { mapPiEvent, type RunEnvelope } from "../pi-event-mapper";
import { interceptorToolName } from "../builtin-tools";
import { collectExtensions, composeSystemPrompt } from "./collect";
import type { AgentBackend, AmbientSkill, RunTurnArgs, TurnOutcome } from "./types";

const TAG = "pi:";

/** Parse a stored resume token into a pi session-file path, or null if it isn't
 *  a pi token. Legacy untagged tokens (raw paths from before backend tagging)
 *  are accepted as pi paths. */
function piSessionPath(token: string | null): string | null {
  if (!token) return null;
  if (token.startsWith(TAG)) return token.slice(TAG.length);
  if (token.startsWith("claude:")) return null; // foreign — start fresh
  return token; // legacy untagged → treat as a pi path
}

function writeSkill(cwd: string, skill: AmbientSkill): void {
  const dir = path.join(cwd, ".pi", "skills", skill.name);
  fs.mkdirSync(dir, { recursive: true });
  const front = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), `${front}\n${skill.body}\n`);
}

export class PiBackend implements AgentBackend {
  readonly id = "pi" as const;

  async runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
    const { cwd, model, thinkingLevel, extensions, abort, prompt, onEvent } = args;

    const collected = await collectExtensions(extensions);

    // Skills must exist on disk before pi scans .pi/skills during session setup.
    for (const skill of collected.skills) writeSkill(cwd, skill);

    const factory: PiExtensionFactory = (pi: any) => {
      for (const tool of collected.tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          parameters: tool.parameters,
          execute: async (id: string, params: any) => {
            const r = await tool.execute(id, params);
            return { content: r.content, details: r.details, isError: r.isError ?? false };
          },
        });
      }

      if (collected.systemPromptFns.length > 0) {
        pi.on("before_agent_start", async (event: any) => {
          const next = await composeSystemPrompt(event.systemPrompt ?? "", collected.systemPromptFns);
          return { systemPrompt: next };
        });
      }

      if (collected.interceptors.length > 0) {
        pi.on("tool_call", async (event: any) => {
          for (const fn of collected.interceptors) {
            // pi's built-ins are already lowercase but use its own names
            // (`find`/`ls`); fold them into the shared canonical vocabulary so
            // interceptors key on one set of names across both harnesses.
            const decision = await fn({ toolName: interceptorToolName(event.toolName), input: event.input });
            if (!decision) continue;
            if ("block" in decision) return { block: true, reason: decision.reason };
            if ("input" in decision) Object.assign(event.input, decision.input);
          }
        });
      }

      if (collected.agentStartFns.length > 0) {
        pi.on("agent_start", (_event: any, ctx: any) => {
          for (const fn of collected.agentStartFns) {
            fn({ abort: () => { try { ctx.abort(); } catch { /* swallow */ } } });
          }
        });
      }
    };

    const sessionDir = path.join(cwd, ".pi", "sessions");
    const resumePath = piSessionPath(args.resumeToken);
    const sessionManager = resumePath
      ? SessionManager.open(resumePath, sessionDir)
      : SessionManager.create(cwd, sessionDir);

    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [factory],
    });

    const { session } = await createAgentSession({
      cwd,
      model: getModel(model.provider as any, model.id as any),
      thinkingLevel: thinkingLevel as any,
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader,
    });

    const envelopes: RunEnvelope[] = [];
    let summary: string | null = null;
    let lastAssistantText: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let turns = 0;

    const stop = session.subscribe((rawEv: any) => {
      if (abort.signal.aborted) return;
      if (rawEv.type === "turn_end") turns += 1;

      for (const env of mapPiEvent(rawEv, session, sessionManager)) {
        // Tag the session-file path so the stored resume token is backend-scoped.
        if (env.type === "system" && env.subtype === "init" && env.session_id) {
          env.session_id = `${TAG}${env.session_id}`;
        }
        envelopes.push(env);
        onEvent(env);

        if (env.type === "assistant" && env.message?.content) {
          const text = env.message.content
            .filter((b: any) => b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n").trim();
          if (text) lastAssistantText = text;
        }
        if (env.type === "result") {
          if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
          inputTokens = env.usage?.input_tokens ?? inputTokens;
          outputTokens = env.usage?.output_tokens ?? outputTokens;
        }
      }
    });

    try {
      await session.prompt(prompt); // resolves after agent_end settles
    } finally {
      stop();
    }

    const file = sessionManager.getSessionFile();
    return {
      envelopes,
      summary: summary ?? lastAssistantText,
      resumeToken: file ? `${TAG}${file}` : args.resumeToken,
      totalCostUsd: null, // pi does not surface total_cost_usd
      inputTokens,
      outputTokens,
      turns,
    };
  }

  listProviders() {
    return getProviders()
      .map((id) => ({ id, models: getModels(id).map((m) => ({ id: m.id, name: m.name })) }))
      .filter((p) => p.models.length > 0);
  }
}
