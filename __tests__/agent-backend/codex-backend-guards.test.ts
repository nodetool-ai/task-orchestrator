import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBackend, __test } from "../../lib/agent-backend/codex-backend";
import type { RunTurnArgs } from "../../lib/agent-backend/types";

// Stand in for the whole SDK: the backend imports it dynamically, and a real
// thread would spawn the `codex` CLI (and bill a model call).
const sdk = vi.hoisted(() => ({
  ctorOptions: null as any,
  threadOptions: null as any,
  resumedFrom: null as string | null,
  inputs: [] as string[],
  /** Scripted event streams, one per runStreamed call. */
  scripts: [] as Array<any[] | Error>,
}));

vi.mock("@openai/codex-sdk", () => {
  class Thread {
    id: string | null = null;
    constructor(private readonly resumeId: string | null) {
      this.id = resumeId;
    }
    async runStreamed(input: string) {
      sdk.inputs.push(input);
      const script = sdk.scripts.shift() ?? [];
      if (script instanceof Error) throw script;
      const self = this;
      return {
        events: (async function* () {
          for (const ev of script) {
            if (ev instanceof Error) throw ev;
            if (ev.type === "thread.started") self.id = ev.thread_id;
            yield ev;
          }
        })(),
      };
    }
  }
  return {
    Codex: class {
      constructor(options: any) {
        sdk.ctorOptions = options;
      }
      startThread(options: any) {
        sdk.threadOptions = options;
        sdk.resumedFrom = null;
        return new Thread(null);
      }
      resumeThread(id: string, options: any) {
        sdk.threadOptions = options;
        sdk.resumedFrom = id;
        return new Thread(id);
      }
    },
  };
});

function makeArgs(overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    cwd: "/tmp/worktree",
    model: { provider: "openai", id: "gpt-5.6-terra" },
    extensions: [],
    resumeToken: null,
    abort: new AbortController(),
    prompt: "do the thing",
    onEvent: () => {},
    ...overrides,
  };
}

const started = (id: string) => ({ type: "thread.started", thread_id: id });
const completed = { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } };
const said = (text: string) => ({
  type: "item.completed",
  item: { id: "m1", type: "agent_message", text },
});

beforeEach(() => {
  sdk.ctorOptions = null;
  sdk.threadOptions = null;
  sdk.resumedFrom = null;
  sdk.inputs = [];
  sdk.scripts = [];
  __test.setSpawnRetryDelays([1, 1]);
});

afterEach(() => {
  __test.setSpawnRetryDelays(null);
  vi.unstubAllEnvs();
});

describe("CodexBackend.runTurn guards", () => {
  it("rejects postgres context (the lightweight loop is pi-only)", async () => {
    await expect(
      new CodexBackend().runTurn(
        makeArgs({ contextSource: { kind: "postgres" } as any })
      )
    ).rejects.toThrow(/does not support contextSource='postgres'/);
  });

  it("rejects a non-OpenAI provider before reaching the SDK", async () => {
    await expect(
      new CodexBackend().runTurn(
        makeArgs({ model: { provider: "anthropic", id: "claude-opus-4-8" } })
      )
    ).rejects.toThrow(/only supports OpenAI\/Codex models/);
  });

  it("accepts pi's openai-codex spelling of the provider", async () => {
    sdk.scripts = [[started("th_1"), completed]];
    await expect(
      new CodexBackend().runTurn(
        makeArgs({ model: { provider: "openai-codex", id: "gpt-5.6-terra" } })
      )
    ).resolves.toBeTruthy();
  });
});

describe("CodexBackend.runTurn CLI configuration", () => {
  it("scrubs server secrets from the CLI env but keeps its own credential", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://prod");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs());
    expect(sdk.ctorOptions.env.DATABASE_URL).toBeUndefined();
    expect(sdk.ctorOptions.env.OPENAI_API_KEY).toBe("sk-test");
    expect(sdk.ctorOptions.env.CODEX_HOME).toBeTruthy();
    // …and those same credentials are withheld from the shell tool's children.
    const policy = sdk.ctorOptions.config.shell_environment_policy;
    expect(policy.exclude).toContain("OPENAI_API_KEY");
    // Codex's default excludes drop every *KEY*/*TOKEN*/*SECRET* name, which
    // would take GH_TOKEN with them and leave the run unable to push or open
    // its PR. Our own list replaces them.
    expect(policy.ignore_default_excludes).toBe(true);
    expect(policy.exclude).not.toContain("GH_TOKEN");
  });

  it("puts the caller's run-scoped env in the CLI env, where shell commands inherit it", async () => {
    // lib/extensions/sandbox.ts exports TASK_ORCH_DB per bash call on the other
    // backends; here it is simply present in the CLI's environment (and not on
    // the shell exclude list), which every shell command inherits.
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs({ env: { TASK_ORCH_DB: "/tmp/sandbox.db" } }));
    expect(sdk.ctorOptions.env.TASK_ORCH_DB).toBe("/tmp/sandbox.db");
    expect(sdk.ctorOptions.config.shell_environment_policy.exclude).not.toContain("TASK_ORCH_DB");
  });

  it("wires registered tools in as the only MCP server, with the token in the env", async () => {
    sdk.scripts = [[started("th_1"), completed]];
    const withTool = (reg: any) =>
      reg.registerTool({
        name: "task_orch__create_task",
        description: "d",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [] }),
      });
    await new CodexBackend().runTurn(makeArgs({ extensions: [withTool] }));

    const servers = sdk.ctorOptions.config.mcp_servers;
    expect(Object.keys(servers)).toEqual(["task_orch"]);
    expect(servers.task_orch.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // The bearer travels in the environment, never on a command line.
    const varName = servers.task_orch.bearer_token_env_var;
    expect(sdk.ctorOptions.env[varName]).toHaveLength(64);
  });

  it("registers no MCP server when the run contributes no tools", async () => {
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs());
    expect(sdk.ctorOptions.config.mcp_servers).toBeUndefined();
  });

  it("confines writes with Codex's own sandbox, overridable per deployment", async () => {
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs());
    expect(sdk.threadOptions).toMatchObject({
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      workingDirectory: "/tmp/worktree",
      model: "gpt-5.6-terra",
    });

    vi.stubEnv("TASK_ORCH_CODEX_SANDBOX", "danger-full-access");
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs());
    expect(sdk.threadOptions.sandboxMode).toBe("danger-full-access");
  });

  it("passes xhigh reasoning through unchanged (Codex's vocabulary is a superset)", async () => {
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs({ thinkingLevel: "xhigh" }));
    expect(sdk.threadOptions.modelReasoningEffort).toBe("xhigh");
  });
});

describe("CodexBackend.runTurn conversation handling", () => {
  it("prepends the persona preamble to a fresh thread only", async () => {
    const persona = (reg: any) => reg.transformSystemPrompt(() => "You are the implementor.");
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs({ extensions: [persona] }));
    expect(sdk.inputs[0]).toContain("You are the implementor.");
    expect(sdk.inputs[0]).toContain("do the thing");

    // A resumed thread already carries the preamble in its history.
    sdk.scripts = [[started("th_1"), completed]];
    sdk.inputs = [];
    await new CodexBackend().runTurn(
      makeArgs({ extensions: [persona], resumeToken: "codex:th_1" })
    );
    expect(sdk.resumedFrom).toBe("th_1");
    expect(sdk.inputs[0]).toBe("do the thing");
  });

  it("folds ambient skills into the same preamble", async () => {
    const skill = (reg: any) =>
      reg.addAmbientSkill({ name: "memory", description: "what I learned", body: "notes" });
    sdk.scripts = [[started("th_1"), completed]];
    await new CodexBackend().runTurn(makeArgs({ extensions: [skill] }));
    expect(sdk.inputs[0]).toContain("# memory");
    expect(sdk.inputs[0]).toContain("notes");
  });

  it("ignores a resume token belonging to another backend", async () => {
    sdk.scripts = [[started("th_new"), completed]];
    const out = await new CodexBackend().runTurn(makeArgs({ resumeToken: "claude:abc" }));
    expect(sdk.resumedFrom).toBeNull();
    expect(out.resumeToken).toBe("codex:th_new");
  });

  it("tags the thread id as the resume token and reports usage without a cost", async () => {
    sdk.scripts = [[started("th_9"), said("finished"), completed]];
    const out = await new CodexBackend().runTurn(makeArgs());
    expect(out).toMatchObject({
      resumeToken: "codex:th_9",
      summary: "finished",
      inputTokens: 7,
      outputTokens: 3,
      totalCostUsd: null,
      turns: 1,
    });
  });

  it("falls back to a fresh thread — once, with a context-loss note — when the transcript is gone", async () => {
    sdk.scripts = [
      new Error("thread th_gone not found"),
      [started("th_fresh"), said("recovered"), completed],
    ];
    const events: any[] = [];
    const out = await new CodexBackend().runTurn(
      makeArgs({ resumeToken: "codex:th_gone", onEvent: (e) => { events.push(e); } })
    );
    expect(out.resumeToken).toBe("codex:th_fresh");
    expect(sdk.inputs[1]).toContain("Context recovery");
    // Exactly one init row persisted across the two attempts.
    expect(events.filter((e) => e.type === "system" && e.subtype === "init")).toHaveLength(1);
  });

  it("retries a CLI launch failure, then reports it as an infrastructure fault", async () => {
    sdk.scripts = [
      new Error("Failed to spawn codex process"),
      new Error("Failed to spawn codex process"),
      new Error("Failed to spawn codex process"),
    ];
    await expect(new CodexBackend().runTurn(makeArgs())).rejects.toThrow(
      /failed to launch after 3 attempts — an infrastructure fault/
    );
  });

  it("surfaces an abort as a thrown error so the run lands cancelled", async () => {
    const abort = new AbortController();
    sdk.scripts = [[started("th_1"), said("partial")]];
    abort.abort();
    await expect(new CodexBackend().runTurn(makeArgs({ abort }))).rejects.toThrow(/Turn aborted/);
  });
});

describe("CodexBackend failure classification", () => {
  it("recognises the CLI's several ways of saying the transcript is gone", () => {
    for (const message of [
      // Verbatim from `codex exec resume <unknown-id>` (v0.153), as the SDK
      // surfaces it: "Codex Exec exited with code 1: <stderr>".
      "Codex Exec exited with code 1: Error: thread/resume: thread/resume failed: " +
        "no rollout found for thread id 01a070ac-0000-0000-0000-000000000000 (code -32600)",
      "thread th_1 not found",
      "No session found with id th_1",
      "conversation does not exist",
      "rollout for this session is missing",
    ]) {
      expect(__test.isResumeLost(message), message).toBe(true);
    }
    expect(__test.isResumeLost("model overloaded")).toBe(false);
    // A live-stream failure must not be mistaken for a dangling resume token.
    expect(__test.isResumeLost("stream closed unexpectedly")).toBe(false);
  });

  it("recognises a launch failure", () => {
    expect(__test.isSpawnFailure("spawn codex ENOENT")).toBe(true);
    expect(__test.isSpawnFailure("Failed to spawn codex process")).toBe(true);
    expect(__test.isSpawnFailure("rate limited")).toBe(false);
  });

  it("treats a missing platform CLI as permanent, not something to retry", () => {
    // Verbatim from the SDK's binary resolution.
    const message =
      "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with " +
      "optional dependencies.";
    expect(__test.isMissingCli(message)).toBe(true);
    expect(__test.isSpawnFailure(message)).toBe(false);
  });
});

describe("CodexBackend.listProviders", () => {
  it("offers OpenAI models under the id the model picker emits", () => {
    const [openai, ...rest] = new CodexBackend().listProviders();
    expect(rest).toEqual([]);
    expect(openai.id).toBe("openai");
    expect(openai.models.map((m) => m.id)).toContain("gpt-5.6-terra");
  });
});
