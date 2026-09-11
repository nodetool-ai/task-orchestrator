// lib/agent-backend/codex-backend.ts
//
// Codex Agent SDK adapter (`@openai/codex-sdk`, which drives the `codex` CLI as
// a child process over a JSONL event stream). Maps the neutral RunTurnArgs onto
// a Codex thread:
//   - registered tools     → a loopback Streamable-HTTP MCP server
//                            (codex-mcp-bridge.ts) wired in as
//                            `mcp_servers.task_orch`.
//   - system-prompt fns    → composed and prepended to the first prompt of a
//     + ambient skills       thread as a delimited preamble. The CLI has no
//                            "append to system prompt" seam and its
//                            `base_instructions` REPLACES the built-in agent
//                            instructions (losing Codex's own tool guidance), so
//                            the preamble goes in the conversation instead — on
//                            a fresh thread only, since a resumed thread already
//                            carries it in history.
//   - tool-call interceptors → enforced for MCP tools inside the bridge. See
//                            "Interceptor coverage" below for the built-ins.
//   - abort wiring         → the SDK's per-turn AbortSignal.
//   - auth + CODEX_HOME    → codex-auth.ts.
//
// Interceptor coverage. The bridge runs the interceptor chain for every
// orchestrator tool call, so the planning-stage gates (lib/extensions/planning.ts)
// hold exactly as they do on pi and Claude. Codex's *built-in* shell and
// apply_patch tools do not pass through it, so the two built-in interceptors are
// met structurally instead of by mutation:
//   - lib/extensions/env-scrub.ts prepends `unset …` to bash commands. Here the
//     CLI process itself is started with a scrubbed environment
//     (scrubCodexCliEnv), and its own auth vars are additionally kept out of
//     shell children via shell_environment_policy.exclude — so the secrets are
//     absent rather than unset after the fact.
//   - lib/extensions/sandbox.ts exports TASK_ORCH_DB per bash call and rejects
//     writes outside cwd. TASK_ORCH_DB is placed directly in the CLI env, and
//     write containment is delegated to Codex's own sandbox (TASK_ORCH_CODEX_SANDBOX,
//     default `workspace-write`, which confines writes to the working directory
//     at the OS level — strictly stronger than a path check on a tool argument).
//     A deployment that already isolates the run (the worker container model, which
//     is how the Claude backend runs with permissionMode "bypassPermissions") can
//     set `danger-full-access`.
//
// The SDK is imported dynamically so neither it nor the ~300MB platform CLI it
// depends on loads under the pi or Claude backends.

import { codexErrorMessage, mapCodexEvent } from "./codex-event-mapper";
import { createBackendProgressReporter } from "./progress";
import { collectExtensions, composeSystemPrompt } from "./collect";
import { CODEACT_BACKEND_GUIDANCE, withCodeActCapabilities } from "./codeact-capabilities";
import { createUsageAccumulator } from "./usage";
import { startCodexMcpBridge, type CodexMcpBridge } from "./codex-mcp-bridge";
import { resolveCodexAuth } from "./codex-auth";
import { scrubCodexCliEnv, CODEX_CLI_AUTH_KEYS } from "./env-scrub";
import { config } from "../config";
import type { AgentBackend, RunTurnArgs, TurnOutcome } from "./types";
import type { RunEnvelope } from "../pi-event-mapper";

const TAG = "codex:";
const MCP_SERVER_NAME = "task_orch";

/** Providers whose models this backend can serve. pi calls the OAuth flavour
 *  `openai-codex`; the persona/model picker may carry either spelling. */
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex", "codex"]);

/** The CLI's wording when a `resume <thread-id>` transcript isn't in this
 *  machine's `$CODEX_HOME/sessions`. Threads live on whichever filesystem ran
 *  the previous turn, and a run can legally land on a machine that never had
 *  it, so this must degrade to a fresh thread (context loss, flagged to the
 *  model) rather than fail the turn — the dispatch layer replays the unanswered
 *  user-message backlog as the prompt, so the fresh thread still gets the
 *  actual instruction. Deliberately broader than the Claude equivalent because
 *  the CLI phrases this several ways ("thread", "session", "conversation"). */
const RESUME_LOST_RE =
  /no (thread|session|conversation|rollout) found|(thread|session|conversation|rollout)[^.]{0,40}?(not found|no longer|does ?n'?o?t exist|doesn'?t exist|missing|unknown)/i;

const RESUME_LOST_NOTE =
  "Context recovery: this run's previous thread transcript is no longer available " +
  "(its storage was recycled or the run moved machines), so this is a fresh thread. " +
  "Prior conversation history is NOT in your context — re-derive the current state from " +
  "the prompt, the repository/checkout, and any recorded notes, tasks, or PRs before acting.";

/** The SDK cannot find the CLI at all — @openai/codex is installed without its
 *  platform package (an image built with `npm ci --omit=optional`, or a partial
 *  install). Permanent for this process, so it is reported rather than retried. */
const MISSING_CLI_RE = /Unable to locate Codex CLI binaries/i;

/** The child failed to launch. Same class of infrastructure fault the Claude
 *  adapter retries — a broken runner snapshot, a transient exec failure — not an
 *  agent error, so it gets settle delays rather than failing the run
 *  milliseconds into its turn. */
const SPAWN_FAILURE_RE = /failed to spawn|spawn\s.*?(?:ENOENT|EACCES)/i;

const DEFAULT_SPAWN_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000];
let spawnRetryDelaysMs: readonly number[] = DEFAULT_SPAWN_RETRY_DELAYS_MS;

export const __test = {
  isMissingCli(message: string): boolean {
    return MISSING_CLI_RE.test(message);
  },
  isResumeLost(message: string): boolean {
    return RESUME_LOST_RE.test(message);
  },
  isSpawnFailure(message: string): boolean {
    return SPAWN_FAILURE_RE.test(message);
  },
  setSpawnRetryDelays(delays: readonly number[] | null): void {
    spawnRetryDelaysMs = delays ?? DEFAULT_SPAWN_RETRY_DELAYS_MS;
  },
};

function codexThreadId(token: string | null): string | undefined {
  if (token && token.startsWith(TAG)) return token.slice(TAG.length);
  return undefined; // foreign/none → fresh thread
}

/** Drop undefined entries: CodexOptions.env is a Record<string, string> and
 *  REPLACES the child's environment wholesale. */
function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v != null) out[k] = v;
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export class CodexBackend implements AgentBackend {
  readonly id = "codex" as const;

  async runTurn(args: RunTurnArgs): Promise<TurnOutcome> {
    const { cwd, model, thinkingLevel, extensions, abort, prompt, onEvent } = args;
    const progress = createBackendProgressReporter(args.onProgress);

    // Postgres mode (the lightweight in-process loop) drives @earendil-works/pi-ai
    // directly and is pi-only; a lightweight-shaped run is always pi-backed, so
    // this is a guard against a future miswiring — fail loud rather than
    // silently ignoring the request.
    if (args.contextSource?.kind === "postgres") {
      throw new Error(
        "The Codex agent backend does not support contextSource='postgres' " +
          "(the postgres/lightweight loop is pi-only). Use the pi backend for lightweight runs."
      );
    }

    if (model.provider && !SUPPORTED_PROVIDERS.has(model.provider)) {
      throw new Error(
        `The Codex agent backend only supports OpenAI/Codex models, but the run is ` +
          `configured with provider '${model.provider}' (model '${model.id}'). ` +
          `Pick an openai/* model for the run, or switch the run's backend.`
      );
    }

    const collected = withCodeActCapabilities(await collectExtensions(extensions), abort.signal, args.toolCallingMode !== "direct");
    const { Codex } = await importCodexSdk();

    // Tools → loopback MCP server. Interceptors run inside it (see module note).
    let bridge: CodexMcpBridge | null = null;
    if (collected.tools.length > 0) {
      bridge = await startCodexMcpBridge({
        tools: collected.tools,
        interceptors: collected.interceptors,
        serverName: MCP_SERVER_NAME,
      });
    }

    try {
      // Persona transforms + ambient skills, as a preamble for a fresh thread.
      const parts: string[] = [];
      const persona = (await composeSystemPrompt("", collected.systemPromptFns)).trim();
      if (persona) parts.push(persona);
      for (const s of collected.skills) parts.push(`# ${s.name}\n${s.description}\n\n${s.body}`);
      const preamble = parts.join("\n\n");
      // MCP tools may be deferred behind Codex's tool discovery interface.
      // Repeat this on resumed turns too: older transcripts may claim these
      // tools are unavailable and otherwise keep falling back to the task CLI.
      const toolGuidance = bridge
        ? `${CODEACT_BACKEND_GUIDANCE}\n\nRun tools are available through the MCP server '${MCP_SERVER_NAME}'. ` +
          "If they are not visible, discover/load that server's tools using the available tool discovery interface " +
          "(in code mode, inspect ALL_TOOLS for task_orch and call the matching tools entry). " +
          "Use these tools for orchestrator operations; the worker has no direct database access, " +
          "so the repository task CLI cannot replace them. Registered MCP tool names: " +
          collected.tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`).join(", ")
        : "";

      // Abort wiring: onAgentStart hooks (the abort bridge) observe the same
      // controller the turn's AbortSignal comes from.
      for (const fn of collected.agentStartFns) fn({ abort: () => abort.abort() });

      const auth = resolveCodexAuth({ ...process.env, ...args.env });
      // The Codex SDK does not translate OPENAI_API_KEY itself. Its `apiKey`
      // option is the supported handoff to the CLI, which then sets
      // CODEX_API_KEY for the child process. Prefer the Codex-specific name
      // when both are configured so an explicit Codex credential wins.
      const mergedEnv = { ...process.env, ...args.env };
      const apiKey =
        auth.mode === "api-key"
          ? nonEmpty(mergedEnv.CODEX_API_KEY) ?? nonEmpty(mergedEnv.OPENAI_API_KEY)
          : undefined;
      // The CLI's env REPLACES the child environment, so start from the merged
      // process env, layer the caller's, then scrub — a caller-supplied entry is
      // respected but still subject to the scrub.
      const cliEnv = definedEnv({
        ...scrubCodexCliEnv(mergedEnv),
        CODEX_HOME: auth.codexHome,
        ...(bridge ? { [bridge.tokenEnvVar]: bridge.token } : {}),
      });

      const codex = newCodexClient(Codex, {
        ...(apiKey ? { apiKey } : {}),
        ...(config.agent.codexBinary ? { codexPathOverride: config.agent.codexBinary } : {}),
        env: cliEnv,
        config: {
          // Only OUR orchestrator server. The CLI would otherwise also load MCP
          // servers from its config.toml; a "task-orchestrator" entry there
          // pointed at a *remote* deployment would have the agent write
          // plans/tasks to that remote DB — the run reports success and nothing
          // appears in this instance. codex-auth.ts keeps runs in a home we own
          // for the same reason; this is the belt to that's suspenders.
          ...(bridge
            ? {
                mcp_servers: {
                  [MCP_SERVER_NAME]: {
                    url: bridge.url,
                    bearer_token_env_var: bridge.tokenEnvVar,
                    // These tools are part of the run's contract. Optional MCP
                    // servers can miss the initial catalogue's startup grace
                    // window, or fail silently while the agent keeps working.
                    required: true,
                    startup_timeout_sec: 30,
                    // MCP approval is independent of approvalPolicy='never':
                    // without this, Codex rejects calls that would prompt.
                    // The run-scoped bridge already enforces interceptors and
                    // the control plane authorizes orchestrator operations.
                    default_tools_approval_mode: "approve",
                  },
                },
              }
            : {}),
          // Keep the CLI's own credentials out of the environment of the shell
          // commands it runs — the residual the bash unset-prefix covers on the
          // other backends.
          //
          // ignore_default_excludes matters: Codex otherwise drops every
          // *KEY*/*TOKEN*/*SECRET* name from a shell command's environment, and
          // that would take GH_TOKEN/GITHUB_TOKEN with it — the credentials the
          // run needs to clone, push and open its PR. This repo's posture
          // (lib/agent-backend/env-scrub.ts KEEP_FOR_GIT) deliberately keeps
          // those two and removes the rest, and the CLI env handed in above is
          // already scrubbed of everything in SECRET_ENV_DENYLIST except the
          // CLI's own auth — so that auth is all the shell still needs removed.
          shell_environment_policy: {
            ignore_default_excludes: true,
            exclude: [...CODEX_CLI_AUTH_KEYS],
          },
        },
      });

      const threadOptions = {
        ...(model.id ? { model: model.id } : {}),
        workingDirectory: cwd,
        // A run's cwd is usually a git worktree, but chat-shaped runs can point
        // at a plain directory; the check would fail those outright.
        skipGitRepoCheck: true,
        sandboxMode: config.agent.codexSandbox,
        // Approvals have no interactive channel in a run — the sandbox mode is
        // the policy.
        approvalPolicy: "never" as const,
        networkAccessEnabled: true,
        // Codex's reasoning-effort vocabulary is a superset of the neutral one,
        // so every level (xhigh included) passes through unchanged.
        ...(thinkingLevel ? { modelReasoningEffort: thinkingLevel } : {}),
      };

      let threadId = codexThreadId(args.resumeToken);

      const envelopes: RunEnvelope[] = [];
      let usage = createUsageAccumulator();
      let summary: string | null = null;
      let lastAgentMessage: string | null = null;
      let turns = 0;
      let observedThreadId: string | null = null;
      // Whether a system/init has already been handed to onEvent (and persisted).
      // Lives ACROSS attempts so a retry doesn't persist a second init row.
      let persistedInit = false;
      // Persist command starts immediately. If a command wedges and the idle
      // watchdog aborts the turn, its identity and command remain visible even
      // though Codex never produced item.completed.
      const startedItemIds = new Set<string>();

      let resumeLostRetried = false;
      let spawnRetries = 0;
      let retried = false;

      while (true) {
        envelopes.length = 0;
        usage = createUsageAccumulator();
        summary = null;
        lastAgentMessage = null;
        turns = 0;
        observedThreadId = null;
        let terminalEvent: "completed" | "failed" | null = null;
        let terminalFailureMessage: string | null = null;
        let lastStreamError: string | null = null;

        // A resumed thread already carries the preamble in its history; only a
        // fresh one needs it. The context-loss note rides along on the retry.
        const header = threadId
          ? resumeLostRetried
            ? RESUME_LOST_NOTE
            : ""
          : [preamble, resumeLostRetried ? RESUME_LOST_NOTE : ""].filter(Boolean).join("\n\n");
        const turnHeader = [header, toolGuidance].filter(Boolean).join("\n\n");
        const input = turnHeader ? `${turnHeader}\n\n---\n\n${prompt}` : prompt;

        const thread = threadId
          ? codex.resumeThread(threadId, threadOptions)
          : codex.startThread(threadOptions);

        try {
          const { events } = await thread.runStreamed(input, { signal: abort.signal });
          for await (const ev of events) {
            if (abort.signal.aborted) break;
            progress.codex(ev);
            if (ev.type === "item.started" && ev.item?.type === "command_execution" && typeof ev.item.id === "string") {
              startedItemIds.add(ev.item.id);
            }
            if (ev.type === "thread.started" && ev.thread_id) observedThreadId = ev.thread_id;
            if (!terminalEvent && ev.type === "turn.completed") {
              terminalEvent = "completed";
              turns += 1;
            } else if (!terminalEvent && ev.type === "turn.failed") {
              terminalEvent = "failed";
              terminalFailureMessage = codexErrorMessage(ev.error, "Turn failed");
              turns += 1;
            } else if (ev.type === "error") {
              // The CLI can report a recoverable stream error (including a
              // reconnect) and continue with the same turn. Keep the latest
              // diagnostic for an eventual unexpected EOF, but do not close
              // the turn here.
              lastStreamError = codexErrorMessage(ev.message, "Codex stream error");
            }

            for (const env of mapCodexEvent(ev, { lastAgentMessage, startedItemIds })) {
              const isInit = env.type === "system" && env.subtype === "init";
              if (isInit && env.session_id) env.session_id = `${TAG}${env.session_id}`;
              envelopes.push(env);

              // Keep the init in the in-memory list (it carries the resume
              // token) but don't persist a duplicate on a retry.
              if (isInit && retried && persistedInit) {
                // duplicate init from the retry — in-memory only
              } else {
                if (isInit) persistedInit = true;
                await onEvent(env);
              }

              if (env.type === "assistant" && env.message?.content) {
                const text = env.message.content
                  .filter((b: any) => b.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join("\n")
                  .trim();
                if (text) lastAgentMessage = text;
              }
              if (env.type === "result") {
                if (!env.is_error && typeof env.result === "string") {
                  summary = env.result.trim() || null;
                }
                usage.observeResult({
                  inputTokens: env.usage?.input_tokens,
                  outputTokens: env.usage?.output_tokens,
                  totalCostUsd: env.total_cost_usd,
                });
              }
            }
            // turn.failed is terminal. Stop consuming the SDK iterator after
            // its mapped result has been handed to onEvent; otherwise a broken
            // CLI could leave this turn waiting on a stream that never closes.
            if (terminalEvent === "failed") {
              throw new Error(`Codex turn failed: ${terminalFailureMessage ?? "Turn failed"}`);
            }
          }
          if (!terminalEvent && !abort.signal.aborted) {
            const detail = lastStreamError ? ` Last stream error: ${lastStreamError}` : "";
            throw new Error(
              `Codex stream ended before a terminal turn event (turn.completed or turn.failed).${detail}`
            );
          }
          observedThreadId = observedThreadId ?? thread.id ?? null;
        } catch (err) {
          // A terminal SDK failure is an agent-turn failure, never a resume or
          // CLI-launch retry, even if its diagnostic happens to contain words
          // such as "spawn" or "not found".
          if (terminalEvent === "failed") throw err;
          const message = err instanceof Error ? err.message : String(err);
          if (!resumeLostRetried && threadId && !abort.signal.aborted && RESUME_LOST_RE.test(message)) {
            console.error(
              `[CodexBackend] thread ${threadId} not found in ${auth.codexHome}/sessions; retrying with a fresh thread`
            );
            threadId = undefined;
            resumeLostRetried = true;
            retried = true;
            continue;
          }
          if (!abort.signal.aborted && SPAWN_FAILURE_RE.test(message)) {
            if (spawnRetries < spawnRetryDelaysMs.length) {
              const delay = spawnRetryDelaysMs[spawnRetries];
              spawnRetries += 1;
              retried = true;
              console.error(
                `[CodexBackend] codex CLI failed to launch (retry ${spawnRetries}/${spawnRetryDelaysMs.length} in ${delay}ms): ${message.split("\n")[0]}`
              );
              await new Promise<void>((r) => setTimeout(r, delay));
              continue;
            }
            throw new Error(
              `The codex CLI failed to launch after ${spawnRetries + 1} attempts — an infrastructure ` +
                `fault (broken runner snapshot or a missing @openai/codex platform package), not an ` +
                `agent error. Retry the run; if it persists, rebuild the runner image. Last error: ${message}`,
              { cause: err }
            );
          }
          throw err;
        }
        break;
      }

      // An abort that ends the stream without the SDK throwing must still surface
      // as an error so lib/runs.ts treats the turn as a clean cancel instead of
      // overwriting `cancelled` with `completed`.
      if (abort.signal.aborted) throw new Error("Turn aborted");

      const totals = usage.totals();
      return {
        envelopes,
        summary: summary ?? lastAgentMessage,
        resumeToken: observedThreadId ? `${TAG}${observedThreadId}` : args.resumeToken,
        totalCostUsd: totals.totalCostUsd,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        turns,
      };
    } finally {
      await bridge?.close();
    }
  }


  listProviders() {
    // Curated catalog for the model picker, mirroring the shape the Claude
    // backend returns. The CLI carries the authoritative catalog; these are the
    // slugs a run is expected to pick. `openai` is the provider id the picker
    // emits as `openai/<model>`.
    return [
      {
        id: "openai",
        models: [
          { id: "gpt-5.6-terra", name: "GPT-5.6-Terra" },
          { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
          { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
          { id: "gpt-5.5", name: "GPT-5.5" },
          { id: "gpt-5.4", name: "GPT-5.4" },
          { id: "gpt-5.4-mini", name: "GPT-5.4-Mini" },
        ],
      },
    ];
  }
}

/** Construct the client, turning "the platform CLI isn't installed" into the
 *  same actionable message the missing-SDK path gives. The SDK resolves the
 *  binary in its constructor, so this is where that failure surfaces. */
function newCodexClient(
  Codex: typeof import("@openai/codex-sdk").Codex,
  options: ConstructorParameters<typeof import("@openai/codex-sdk").Codex>[0]
): InstanceType<typeof import("@openai/codex-sdk").Codex> {
  try {
    return new Codex(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (MISSING_CLI_RE.test(message)) {
      throw new Error(`${CODEX_UNAVAILABLE}. Underlying error: ${message}`, { cause: err });
    }
    throw err;
  }
}

const CODEX_UNAVAILABLE =
  "The Codex agent backend needs @openai/codex-sdk and its platform CLI, which are not " +
  "installed in this environment. They are optional dependencies (the CLI is ~300MB), so " +
  "an image built with `npm ci --omit=optional` will not have them — install them, or run " +
  "this run on the pi or claude backend";

/** Import the SDK, turning a missing optional dependency into an actionable
 *  message instead of a bare MODULE_NOT_FOUND from deep in the import chain. */
async function importCodexSdk(): Promise<typeof import("@openai/codex-sdk")> {
  try {
    return await import("@openai/codex-sdk");
  } catch (err) {
    throw new Error(`${CODEX_UNAVAILABLE}.`, { cause: err });
  }
}
