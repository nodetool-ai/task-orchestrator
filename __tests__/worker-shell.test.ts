import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerShellScope } from "../lib/agent-backend/worker-shell";
import type { RunTurnArgs } from "../lib/agent-backend/types";
import type { CollectedCapabilities } from "../lib/agent-backend/collect";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

function fixture() {
  vi.stubEnv("TASK_ORCH_PROCESS_SUPERVISOR", "/worker/process-supervisor.py");
  vi.stubEnv("TASK_ORCH_PROCESS_CGROUP", "/sys/fs/cgroup/task-orchestrator/u1000/instance");
  vi.stubEnv("TASK_ORCH_PROCESS_LOCK", "/worker/command.lock");
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  mocks.spawn.mockReturnValue(child);
  const args: RunTurnArgs = { cwd: "/checkout", model: { provider: "openai", id: "test" }, extensions: [], resumeToken: null,
    abort: new AbortController(), prompt: "test", onEvent: vi.fn(), onProgress: vi.fn() };
  const scope = createWorkerShellScope(args)!;
  const capabilities: CollectedCapabilities = { tools: [], interceptors: [], agentStartFns: [], skills: [], systemPromptFns: [] };
  return { child, args, scope, capabilities, tool: scope.attach(capabilities).tools[0] };
}

describe("shared worker shell capability", () => {
  it("refuses to run without initialized kernel containment and excludes coordinator personas", () => {
    const { args } = fixture();
    vi.stubEnv("TASK_ORCH_PROCESS_CGROUP", "");
    expect(() => createWorkerShellScope(args)).toThrow(/not initialized/);
    expect(createWorkerShellScope({ ...args, nativeToolPolicy: "orchestration-only" })).toBeNull();
  });
  it("routes arbitrary commands through the same supervisor/lock and scrubs credentials", async () => {
    const { child, scope, tool } = fixture();
    vi.stubEnv("DATABASE_URL", "private");
    vi.stubEnv("CODEX_API_KEY", "private");
    vi.stubEnv("GH_TOKEN", "git-credential");
    const running = tool.execute("call", { command: "anything --including-pipelines | other", timeout_seconds: 900 });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    const [exe, argv, options] = mocks.spawn.mock.calls[0];
    expect(exe).toBe("python3");
    expect(argv).toEqual(["/worker/process-supervisor.py", "command", "--timeout-seconds", "900", "--", "bash", "-lc", "anything --including-pipelines | other"]);
    expect(options.env).toMatchObject({ GH_TOKEN: "git-credential", TASK_ORCH_PROCESS_LOCK: "/worker/command.lock" });
    expect(options.env.DATABASE_URL).toBeUndefined();
    expect(options.env.CODEX_API_KEY).toBeUndefined();
    child.emit("close", 0, null);
    expect((await running).isError).toBe(false);
    await scope.close();
  });
  it("keeps canonical bash interceptor denial/mutation on the replacement tool", async () => {
    const { child, scope, capabilities } = fixture();
    capabilities.interceptors.push(async () => ({ block: true, reason: "planning gate" }));
    expect((await scope.attach(capabilities).tools[0].execute("call", { command: "anything" })).isError).toBe(true);
    expect(mocks.spawn).not.toHaveBeenCalled();
    capabilities.interceptors = [async () => ({ input: { command: "modified" } })];
    const running = scope.attach(capabilities).tools[0].execute("call2", { command: "original" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(mocks.spawn.mock.calls[0][1].at(-1)).toBe("modified");
    child.emit("close", 0, null);
    await running;
    await scope.close();
  });
  it("reports actual output progress and bounds retained output", async () => {
    const { child, args, scope, tool } = fixture();
    const running = tool.execute("call", { command: "check" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    expect(args.onProgress).not.toHaveBeenCalled();
    child.stdout.write(Buffer.alloc(100_000, "x"));
    child.emit("close", 1, null);
    const result = await running;
    expect(args.onProgress).toHaveBeenCalledWith("worker_shell.output");
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text).length).toBeLessThan(66_000);
    await scope.close();
  });
  it.each(["abort", "backend end"])("waits for descendant cleanup after %s instead of forgetting the child", async (reason) => {
    const { child, args, scope, tool } = fixture();
    const running = tool.execute("call", { command: "parent-and-nested-children" });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    if (reason === "abort") args.abort.abort();
    const closing = scope.close();
    let drained = false;
    void closing.then(() => { drained = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(drained).toBe(false);
    child.emit("close", 143, null);
    await closing;
    expect((await running).isError).toBe(true);
    await expect(tool.execute("late", { command: "late" })).rejects.toThrow(/closed/);
  });
  it("cancels one nested agent's invocation while the owning turn stays active", async () => {
    const { child, args, scope, tool } = fixture();
    const request = new AbortController();
    const running = tool.execute("call", { command: "nested verification" }, request.signal);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    request.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(args.abort.signal.aborted).toBe(false);
    child.emit("close", 143, null);
    expect((await running).isError).toBe(true);
    await scope.close();
  });
});
