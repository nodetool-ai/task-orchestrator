import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "typebox";
import { runInterceptors, type CollectedCapabilities } from "./collect";
import { scrubEnv } from "./env-scrub";
import type { RunTurnArgs, ToolResult } from "./types";

const MAX_OUTPUT_BYTES = 64 * 1024;
export const WORKER_SHELL_GUIDANCE = "Run shell commands with worker_shell. All agents in this worker share one command slot and an aggregate memory/process budget. A command owns its descendants: background processes are terminated when that command finishes. Give one agent ownership of full-repository verification; reviewers should reuse its results and request focused checks. Set timeout_seconds for a deliberately silent long operation (maximum 1800 seconds).";

/** Sprite's process supervisor supplies these variables only after installing
 * the kernel resource boundary. Other runners retain their existing tools. */
export function createWorkerShellScope(args: RunTurnArgs): WorkerShellScope | null {
  if (!process.env.TASK_ORCH_PROCESS_SUPERVISOR || args.nativeToolPolicy === "orchestration-only") return null;
  if (!process.env.TASK_ORCH_PROCESS_CGROUP || !process.env.TASK_ORCH_PROCESS_LOCK) {
    throw new Error("Worker process containment is not initialized; refusing unbounded shell execution");
  }
  return new WorkerShellScope(args);
}

export class WorkerShellScope {
  private readonly active = new Map<ChildProcess, Promise<void>>();
  private closed = false;
  constructor(private readonly args: RunTurnArgs) {}

  attach(collected: CollectedCapabilities): CollectedCapabilities {
    return {
      ...collected,
      tools: [...collected.tools, {
        name: "worker_shell",
        description: WORKER_SHELL_GUIDANCE,
        parameters: Type.Object({
          command: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          timeout_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800 })),
        }),
        execute: async (_callId, input, signal) => {
          // This is still the canonical bash capability: planning/sandbox/env
          // hooks must not be bypassed by routing it through MCP.
          const decision = await runInterceptors(collected.interceptors, "bash", input);
          if (decision && "block" in decision) return { isError: true, content: [{ type: "text", text: decision.reason }] };
          return this.execute(decision && "input" in decision ? decision.input : input, signal);
        },
      }],
      systemPromptFns: [...collected.systemPromptFns, (base) => `${base}\n\n${WORKER_SHELL_GUIDANCE}`],
    };
  }

  private execute(input: { command?: unknown; timeout_seconds?: unknown }, signal?: AbortSignal): Promise<ToolResult> {
    if (this.closed || this.args.abort.signal.aborted || signal?.aborted) return Promise.reject(new Error("Worker shell scope is closed"));
    const seconds = input.timeout_seconds ?? 120;
    if (typeof input.command !== "string" || !input.command || !Number.isInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 1800) {
      return Promise.reject(new Error("Invalid worker shell command or timeout_seconds"));
    }
    const env = scrubEnv({ ...process.env, ...this.args.env });
    // These are scheduler-owned, never supplied by a model or repository.
    for (const key of ["TASK_ORCH_PROCESS_CGROUP", "TASK_ORCH_PROCESS_LOCK", "TASK_ORCH_PROCESS_SUPERVISOR"]) env[key] = process.env[key];
    const child = spawn("python3", [process.env.TASK_ORCH_PROCESS_SUPERVISOR!, "command", "--timeout-seconds", String(seconds), "--", "bash", "-lc", input.command], {
      cwd: this.args.cwd, env: { ...env, NODE_ENV: process.env.NODE_ENV }, stdio: ["ignore", "pipe", "pipe"],
    });
    const abort = () => { child.kill("SIGTERM"); }; // supervisor owns TERM -> KILL + waitpid for the whole tree
    this.args.abort.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (this.args.abort.signal.aborted || signal?.aborted) abort();
    let output = Buffer.alloc(0);
    let truncated = false;
    const onData = (chunk: Buffer) => {
      if (!chunk.length) return;
      this.args.onProgress?.("worker_shell.output");
      output = Buffer.concat([output, chunk]);
      if (output.length > MAX_OUTPUT_BYTES) { output = output.subarray(-MAX_OUTPUT_BYTES); truncated = true; }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    const result = new Promise<ToolResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({
        isError: code !== 0,
        content: [{ type: "text", text: `${truncated ? "[output truncated to final 64 KiB]\n" : ""}${output.toString("utf8")}\n[exit ${code ?? signal}]` }],
      }));
    }).finally(() => {
      this.args.abort.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
      this.active.delete(child);
    });
    // Observe rejections while the backend's transport may be abandoning a call.
    this.active.set(child, result.then(() => {}, () => {}));
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const child of this.active.keys()) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.active.values()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Command descendants did not drain; worker supervisor must reap the scope")), 7_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
