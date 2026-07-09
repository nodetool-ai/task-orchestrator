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

import { mapPiEvent, type RunEnvelope } from "../pi-event-mapper";
import { interceptorToolName } from "../builtin-tools";
import { resolveCodexAccessToken } from "../codex-oauth-token";
import { collectExtensions, composeSystemPrompt } from "./collect";
import { createUsageAccumulator } from "./usage";
import { runPostgresTurn } from "./postgres-turn";
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
    // Postgres mode: no session files — replay the conversation from the DB and
    // drive pi-ai's completeSimple directly. This is the former lib/chat-ai-loop
    // machinery, now a mode of this backend (R3).
    if (args.contextSource?.kind === "postgres") {
      return runPostgresTurn(args);
    }

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
    // If the resume path doesn't exist (e.g., container/worktree restart), start fresh
    // rather than attempting to open a non-existent session file.
    let sessionManager;
    if (resumePath && fs.existsSync(resumePath)) {
      sessionManager = SessionManager.open(resumePath, sessionDir);
    } else {
      if (resumePath) {
        console.warn(
          `Resume session file not found: ${resumePath}; starting fresh session instead`
        );
      }
      sessionManager = SessionManager.create(cwd, sessionDir);
    }

    const authStorage = AuthStorage.create();
    const codexAccessToken = await resolveCodexAccessToken();
    if (codexAccessToken) authStorage.setRuntimeApiKey("openai-codex", codexAccessToken);
    const modelRegistry = ModelRegistry.create(authStorage);
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [factory],
    });

    // ModelRegistry.find() returns undefined for a provider/model pair absent
    // from pi's registry. createAgentSession would otherwise silently fall back
    // to the default model while the run row still reports the intended one.
    const piModel = modelRegistry.find(model.provider, model.id);
    if (!piModel) {
      throw new Error(
        `Model '${model.provider}/${model.id}' was not found in the pi model registry. ` +
          `Check the persona's provider/model ids, or set TASK_ORCH_AGENT_BACKEND=claude. ` +
          `Use listProviders()/@earendil-works/pi-ai to see the available provider/model ids.`
      );
    }

    const { session } = await createAgentSession({
      cwd,
      model: piModel,
      thinkingLevel: thinkingLevel as any,
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader,
    });

    const envelopes: RunEnvelope[] = [];
    const usage = createUsageAccumulator();
    let summary: string | null = null;
    let lastAssistantText: string | null = null;
    let turns = 0;

    // onEvent persists each envelope to the DB (async). session.subscribe fires
    // its callback synchronously and does not await it, so we serialize the
    // persists through a chain to keep them in stream order, then drain it below.
    // The first persist failure is captured so it can (a) abort the turn promptly
    // rather than only surfacing at the final await, and (b) be re-thrown there.
    let persistChain: Promise<void> = Promise.resolve();
    let persistError: unknown = null;

    const stop = session.subscribe((rawEv: any) => {
      if (abort.signal.aborted) return;
      if (rawEv.type === "turn_end") turns += 1;

      for (const env of mapPiEvent(rawEv, session, sessionManager)) {
        // Tag the session-file path so the stored resume token is backend-scoped.
        if (env.type === "system" && env.subtype === "init" && env.session_id) {
          env.session_id = `${TAG}${env.session_id}`;
        }
        envelopes.push(env);
        persistChain = persistChain.then(() => onEvent(env));
        // Observe each step so a persist rejection can't sit unhandled, and abort
        // the turn on the first failure. persistError is re-thrown after the drain.
        persistChain.catch((err) => {
          if (persistError == null) persistError = err;
          if (!abort.signal.aborted) abort.abort();
        });

        if (env.type === "assistant" && env.message?.content) {
          const text = env.message.content
            .filter((b: any) => b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n").trim();
          if (text) lastAssistantText = text;
        }
        if (env.type === "result") {
          if (!env.is_error && typeof env.result === "string") summary = env.result.trim() || null;
          usage.observeResult({
            inputTokens: env.usage?.input_tokens,
            outputTokens: env.usage?.output_tokens,
            totalCostUsd: env.total_cost_usd,
          });
        }
      }
    });

    try {
      await session.prompt(prompt); // resolves after agent_end settles
    } finally {
      stop();
    }
    // Wait for every persist to settle (rejections were already observed +
    // aborted per-step above), then surface the first failure to the caller.
    await persistChain.catch(() => {});
    if (persistError != null) throw persistError;

    // pi resolves prompt() normally even when the turn was aborted, so signal
    // the cancellation by throwing here. lib/runs.ts's append loop checks
    // abort.signal.aborted in its catch and treats it as a clean cancel; without
    // this the run's success path would overwrite the `cancelled` status with
    // `completed` and push/PR partial work.
    if (abort.signal.aborted) {
      throw new Error("Turn aborted");
    }

    const file = sessionManager.getSessionFile();
    // pi surfaces cost per AssistantMessage (usage.cost.total); pi-event-mapper
    // sums it onto the result envelope, so the accumulator forwards the real total.
    const totals = usage.totals();
    return {
      envelopes,
      summary: summary ?? lastAssistantText,
      resumeToken: file ? `${TAG}${file}` : args.resumeToken,
      totalCostUsd: totals.totalCostUsd,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      turns,
    };
  }

  listProviders() {
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const providers = new Map<string, { id: string; models: { id: string; name: string }[] }>();

    for (const model of modelRegistry.getAll()) {
      const provider = providers.get(model.provider) ?? { id: model.provider, models: [] };
      provider.models.push({ id: model.id, name: model.name });
      providers.set(model.provider, provider);
    }

    return Array.from(providers.values())
      .map((provider) => ({
        ...provider,
        models: provider.models.sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
