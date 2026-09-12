import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexBackend, __test as codexTest } from "../../lib/agent-backend/codex-backend";
import type { Extension, RunTurnArgs } from "../../lib/agent-backend/types";

/**
 * These tests use the real @openai/codex-sdk and its platform CLI. The CLI is
 * pointed at a local Responses WebSocket server and receives a deliberately
 * fake API key, so the test cannot reach OpenAI or use a developer credential.
 */

type MockTurn = {
  kind: "tool" | "complete" | "failed";
  threadId?: string;
};

class LocalResponsesApi {
  readonly server: WebSocketServer;
  readonly turns: MockTurn[] = [];
  readonly inputs: unknown[] = [];
  executed = 0;
  private connectionCount = 0;
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly mode: "tool" | "failed") {
    this.server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      this.handle(socket);
    });
  }

  async ready(): Promise<void> {
    await new Promise<void>((resolve) => this.server.once("listening", () => resolve()));
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("mock API is not listening");
    // The CLI accepts an HTTP base URL and upgrades its Responses endpoint to
    // WebSocket internally.
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: WebSocket): void {
    const threadId = `local-thread-${++this.connectionCount}`;
    let phase = 0;
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString()) as { generate?: boolean; input?: unknown };
      this.inputs.push(request.input);
      if (request.generate === false) {
        socket.send(this.completed("bootstrap", []));
        return;
      }
      if (phase++ > 0) {
        socket.send(this.completed(threadId, []));
        return;
      }

      if (this.mode === "failed") {
        this.turns.push({ kind: "failed", threadId });
        socket.send(JSON.stringify({
          type: "error",
          status: 400,
          error: { type: "invalid_request_error", code: "invalid_request_error", message: "local terminal failure" },
        }));
        return;
      }

      this.turns.push({ kind: "tool", threadId });
      const call = {
        type: "custom_tool_call",
        id: `probe-call-${this.connectionCount}`,
        call_id: `probe-call-${this.connectionCount}`,
        name: "exec",
        namespace: "functions",
        // CodeAct is always on (lib/agent-backend/codeact-capabilities.ts), so the
        // only MCP tools the bridge exposes are codeact_catalog/codeact_execute:
        // the probe is reached as a catalogued operation inside the sandbox.
        input: "text(await tools.mcp__task_orch__codeact_execute({ code: 'return await tools.orch_probe({});' }));",
      };
      socket.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...call, input: "" } }));
      socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item: call }));
      // Closing this response makes the CLI execute the custom function call;
      // it then opens the next Responses request with the tool output.
      socket.send(this.completed(threadId, [call]));
      this.executed += 1;
    });
  }

  private completed(id: string, output: unknown[]): string {
    return JSON.stringify({
      type: "response.completed",
      response: { id, status: "completed", output, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } },
    });
  }
}

function probeExtension(observed: { calls: number }): Extension {
  return (reg) => {
    reg.registerTool({
      name: "orch_probe",
      description: "Probe the local orchestrator bridge",
      parameters: { type: "object", properties: {}, additionalProperties: false } as any,
      execute: async () => {
        observed.calls += 1;
        return { content: [{ type: "text", text: "ORCH_PROBE_OK" }] };
      },
    });
  };
}

function args(cwd: string, extensions: Extension[], overrides: Partial<RunTurnArgs> = {}): RunTurnArgs {
  return {
    cwd,
    model: { provider: "openai", id: "gpt-5.6-terra" },
    extensions,
    resumeToken: null,
    abort: new AbortController(),
    prompt: "Use the orchestrator probe tool.",
    onEvent: () => {},
    ...overrides,
  };
}

async function runBounded(backend: CodexBackend, input: RunTurnArgs): Promise<Awaited<ReturnType<CodexBackend["runTurn"]>>> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  timer.unref?.();
  try {
    return await backend.runTurn({ ...input, abort });
  } finally {
    clearTimeout(timer);
  }
}

let cliAvailable = true;
const scratchRoots: string[] = [];
const inheritedCodexBinary = process.env.TASK_ORCH_CODEX_BINARY;

beforeAll(async () => {
  // Force the SDK's pinned platform CLI; a developer override must not make
  // this integration test exercise a different executable.
  delete process.env.TASK_ORCH_CODEX_BINARY;
  try {
    const { Codex } = await import("@openai/codex-sdk");
    new Codex({ env: { PATH: process.env.PATH ?? "" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code;
    const sdkMissing = (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      message.includes("@openai/codex-sdk");
    if (!sdkMissing && !codexTest.isMissingCli(message)) throw error;
    cliAvailable = false;
  }
});

afterAll(() => {
  if (inheritedCodexBinary === undefined) delete process.env.TASK_ORCH_CODEX_BINARY;
  else process.env.TASK_ORCH_CODEX_BINARY = inheritedCodexBinary;
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

describe("CodexBackend with the real Codex CLI", () => {
  it("executes a bridged MCP tool against a local Responses API", async (ctx) => {
    if (!cliAvailable) return ctx.skip();
    const api = new LocalResponsesApi("tool");
    await api.ready();
    const home = mkdtempSync(path.join(tmpdir(), "task-orch-codex-cli-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "task-orch-codex-cwd-"));
    scratchRoots.push(home, cwd);
    writeFileSync(path.join(home, "config.toml"), `openai_base_url = ${JSON.stringify(api.url)}\n`);
    const observed = { calls: 0 };
    try {
      const outcome = await runBounded(new CodexBackend(),
        args(cwd, [probeExtension(observed)], { env: { CODEX_API_KEY: "fake-local-key", TASK_ORCH_CODEX_HOME: home, HOME: home } })
      );
      expect(observed.calls).toBe(1);
      expect(api.executed).toBe(1);
      expect(outcome.resumeToken).toMatch(/^codex:[0-9a-f-]{36}$/);
      // Usage covers the tool-call response and the final response.
      expect(outcome.inputTokens).toBe(4);
      expect(outcome.outputTokens).toBe(2);
      expect(JSON.stringify(api.inputs)).toContain("ORCH_PROBE_OK");
      // The bridged tool result is now the CodeAct execution record: it must show
      // the probe having run as a subcall, with its output carried back.
      const record = outcome.envelopes
        .filter((e: any) => e.type === "user")
        .flatMap((e: any) => e.message.content)
        .find((block: any) => block.type === "tool_result");
      expect(record).toBeDefined();
      const execution = JSON.parse(record.content[0].text);
      expect(execution.subcalls.map((subcall: any) => subcall.operation)).toContain("tools.orch_probe");
      expect(execution.result.content[0].text).toBe("ORCH_PROBE_OK");
    } finally {
      await api.close();
    }
  }, 30_000);

  it("resumes a Codex thread through the production backend", async (ctx) => {
    if (!cliAvailable) return ctx.skip();
    const api = new LocalResponsesApi("tool");
    await api.ready();
    const home = mkdtempSync(path.join(tmpdir(), "task-orch-codex-resume-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "task-orch-codex-cwd-"));
    scratchRoots.push(home, cwd);
    writeFileSync(path.join(home, "config.toml"), `openai_base_url = ${JSON.stringify(api.url)}\n`);
    const observed = { calls: 0 };
    try {
      const backend = new CodexBackend();
      const first = await runBounded(backend, args(cwd, [probeExtension(observed)], { env: { CODEX_API_KEY: "fake-local-key", TASK_ORCH_CODEX_HOME: home, HOME: home } }));
      const second = await runBounded(backend, args(cwd, [probeExtension(observed)], { resumeToken: first.resumeToken, prompt: "Use it again.", env: { CODEX_API_KEY: "fake-local-key", TASK_ORCH_CODEX_HOME: home, HOME: home } }));
      expect(observed.calls).toBe(2);
      expect(api.turns).toHaveLength(2);
      expect(second.resumeToken).toBe(first.resumeToken);
    } finally {
      await api.close();
    }
  }, 45_000);

  it("surfaces a terminal Codex turn failure", async (ctx) => {
    if (!cliAvailable) return ctx.skip();
    const api = new LocalResponsesApi("failed");
    await api.ready();
    const home = mkdtempSync(path.join(tmpdir(), "task-orch-codex-failed-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "task-orch-codex-cwd-"));
    scratchRoots.push(home, cwd);
    writeFileSync(path.join(home, "config.toml"), `openai_base_url = ${JSON.stringify(api.url)}\n`);
    try {
      await expect(
        runBounded(new CodexBackend(), args(cwd, [], { env: { CODEX_API_KEY: "fake-local-key", TASK_ORCH_CODEX_HOME: home, HOME: home } }))
      ).rejects.toThrow(/Codex turn failed:.*local terminal failure/i);
    } finally {
      await api.close();
    }
  }, 30_000);
});
