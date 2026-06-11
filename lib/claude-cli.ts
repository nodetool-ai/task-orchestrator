// lib/claude-cli.ts
//
// Claude Code CLI harness: run `claude` interactively inside a tmux session
// in a task's worktree, instead of the pi SDK. The orchestrator:
//
//   - writes the prompt and a hooks settings file to a tmpdir state dir
//     (never the worktree — the agent could commit it)
//   - launches tmux running `claude --dangerously-skip-permissions
//     --session-id <uuid> --settings <file> "$(cat prompt.md)"`
//   - learns about lifecycle via Claude Code hooks (SessionStart/Stop/
//     SessionEnd) that curl back to /api/runs/:id/hook with a per-run token
//   - tails the session transcript JSONL for the structured conversation
//   - polls the tmux pane as a fallback (process exit, login screens)
//
// The agent commits/pushes/opens the PR itself; the runner in lib/runs.ts
// only waits for `done` and then finds the PR by branch. This module owns
// tmux/process mechanics and no DB access, so a future harness interface
// can be extracted without touching persistence.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mapTranscriptEntry, parseTranscriptChunk } from "./claude-transcript";
import type { RunEnvelope } from "./pi-event-mapper";

const POLL_MS = 2_000;
const TAIL_MS = 1_000;
/** Start probing the computed transcript path if no SessionStart arrives. */
const TRANSCRIPT_FALLBACK_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const KEEP_DEBUG_STATE = !!process.env.TASK_ORCH_KEEP_WORKTREES;

function claudeBin(): string {
  return process.env.TASK_ORCH_CLAUDE_BIN || "claude";
}
function tmuxBin(): string {
  return process.env.TASK_ORCH_TMUX_BIN || "tmux";
}

// ──────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────

export type ClaudeHookEvent = "SessionStart" | "Stop" | "SessionEnd";

export type ClaudeCliDone =
  | { kind: "stop" }
  | { kind: "exited"; exitCode: number; paneTail: string }
  | { kind: "killed" }
  | { kind: "timeout" };

export interface StartClaudeCliArgs {
  runId: number;
  /** Worktree the agent operates in (tmux session cwd). */
  cwd: string;
  prompt: string;
  /** Pre-generated UUID passed as --session-id; names the transcript file. */
  claudeSessionId: string;
  hookToken: string;
  /** Orchestrator origin the hook curls back to. */
  baseUrl: string;
  timeoutMs?: number;
  onEnvelope: (env: RunEnvelope) => void;
  onSystem: (kind: "warning" | "info", payload: Record<string, unknown>) => void;
}

export interface ClaudeCliHandle {
  tmuxSession: string;
  attachHint: string;
  /** Resolves on the first Stop hook, process exit, killed session, or timeout. */
  done: Promise<ClaudeCliDone>;
  /** Feed a hook callback (called by runs.handleClaudeHook via the route). */
  hook(event: ClaudeHookEvent, payload: Record<string, unknown>): void;
  /** Type a follow-up message into the Claude TUI and wait for the next done. */
  nudge(text: string, waitMs: number): Promise<ClaudeCliDone>;
  /** Kill tmux, stop timers, remove the state dir. Idempotent. */
  cancel(): Promise<void>;
}

// ──────────────────────────────────────────────────────────
// Handle registry (globalThis so the hook route — possibly a different
// module instance under next dev HMR — finds the worker's handle)
// ──────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __claudeCliHandles: Map<number, ClaudeCliHandle> | undefined;
}

const handles: Map<number, ClaudeCliHandle> =
  globalThis.__claudeCliHandles ?? new Map();
if (!globalThis.__claudeCliHandles) globalThis.__claudeCliHandles = handles;

export function getHandle(runId: number): ClaudeCliHandle | undefined {
  return handles.get(runId);
}

// ──────────────────────────────────────────────────────────
// Pure builders (unit-tested)
// ──────────────────────────────────────────────────────────

/** POSIX single-quote escaping; safe for any string. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function tmuxSessionName(runId: number): string {
  return `torch-run-${runId}`;
}

/**
 * The command tmux runs (via `sh -c`). The prompt body never touches the
 * shell line — it lives in prompt.md and is injected via `"$(cat …)"`,
 * whose output is not re-expanded. The trailing interactive shell keeps
 * the session alive after claude exits (an attached user isn't dumped)
 * and the exit-code file is the machine-readable exit signal.
 */
export function buildClaudeCommand(args: {
  claudeBin: string;
  stateDir: string;
  sessionId: string;
}): string {
  const promptFile = shellQuote(join(args.stateDir, "prompt.md"));
  const settingsFile = shellQuote(join(args.stateDir, "settings.json"));
  const exitFile = shellQuote(join(args.stateDir, "exit-code"));
  return [
    `${shellQuote(args.claudeBin)} --dangerously-skip-permissions --session-id ${shellQuote(args.sessionId)} --settings ${settingsFile} "$(cat ${promptFile})"`,
    `echo $? > ${exitFile}`,
    `printf '\\n[task-orchestrator] claude exited (%s)\\n' "$(cat ${exitFile})"`,
    `exec "\${SHELL:-sh}" -i`,
  ].join("; ");
}

/**
 * Settings JSON injected via --settings. Each lifecycle hook forwards its
 * stdin payload verbatim to the orchestrator (payload.hook_event_name says
 * which event fired). `|| true` keeps a dead orchestrator from surfacing
 * curl failures inside the Claude TUI.
 */
export function buildHookSettings(args: {
  runId: number;
  hookToken: string;
  baseUrl: string;
}): Record<string, unknown> {
  const url = `${args.baseUrl.replace(/\/+$/, "")}/api/runs/${args.runId}/hook`;
  const command = `curl -fsS -m 8 -X POST -H ${shellQuote(`Authorization: Bearer ${args.hookToken}`)} -H 'Content-Type: application/json' --data-binary @- ${shellQuote(url)} >/dev/null 2>&1 || true`;
  const entry = [{ hooks: [{ type: "command", command, timeout: 10 }] }];
  return {
    hooks: {
      SessionStart: entry,
      Stop: entry,
      SessionEnd: entry,
    },
  };
}

/**
 * Fallback transcript location when the SessionStart hook never reports
 * one: ~/.claude/projects/<munged cwd>/<session-id>.jsonl, where the cwd
 * munge replaces every non-alphanumeric character with '-'.
 */
export function computeTranscriptPath(cwd: string, sessionId: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", munged, `${sessionId}.jsonl`);
}

const NEEDS_HUMAN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "login", re: /select login method/i },
  { label: "login", re: /paste code here/i },
  { label: "login", re: /sign in to (?:continue|claude)/i },
  { label: "reauth", re: /please run \/login/i },
  { label: "reauth", re: /invalid api key/i },
  { label: "reauth", re: /oauth token (?:expired|revoked)/i },
  { label: "bypass-consent", re: /bypass permissions mode/i },
  { label: "bypass-consent", re: /yes,\s*i accept/i },
];

/**
 * Scan rendered pane text for screens only a human can get past (login,
 * re-auth, the one-time bypass-permissions consent). Returns a short label
 * or null. Heuristic by design — used to warn, never to fail the run.
 */
export function detectNeedsHuman(paneText: string): string | null {
  for (const { label, re } of NEEDS_HUMAN_PATTERNS) {
    if (re.test(paneText)) return label;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Process helpers
// ──────────────────────────────────────────────────────────

function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export async function killTmuxSession(name: string): Promise<void> {
  await run(tmuxBin(), ["kill-session", "-t", name]);
}

/**
 * Fail-fast preflight: both binaries must exist and respond. Returns null
 * when available, otherwise an actionable error message.
 */
export async function checkClaudeCliAvailable(): Promise<string | null> {
  const tmux = await run(tmuxBin(), ["-V"], { timeoutMs: 5_000 });
  if (tmux.code !== 0) {
    return `tmux not available (tried \`${tmuxBin()} -V\`) — install tmux or set TASK_ORCH_TMUX_BIN.`;
  }
  const claude = await run(claudeBin(), ["--version"], { timeoutMs: 15_000 });
  if (claude.code !== 0) {
    return `Claude Code CLI not available (tried \`${claudeBin()} --version\`) — install claude or set TASK_ORCH_CLAUDE_BIN.`;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// The runner
// ──────────────────────────────────────────────────────────

interface Deferred {
  promise: Promise<ClaudeCliDone>;
  resolve: (d: ClaudeCliDone) => void;
  settled: boolean;
}

function deferred(): Deferred {
  let resolveFn!: (d: ClaudeCliDone) => void;
  const promise = new Promise<ClaudeCliDone>((res) => (resolveFn = res));
  const d: Deferred = {
    promise,
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolveFn(v);
    },
  };
  return d;
}

export async function startClaudeCli(args: StartClaudeCliArgs): Promise<ClaudeCliHandle> {
  const session = tmuxSessionName(args.runId);
  const stateDir = join(tmpdir(), "task-orch", `claude-run-${args.runId}`);
  const exitFile = join(stateDir, "exit-code");

  await mkdir(stateDir, { recursive: true });
  await rm(exitFile, { force: true });
  await writeFile(join(stateDir, "prompt.md"), args.prompt, "utf8");
  await writeFile(
    join(stateDir, "settings.json"),
    JSON.stringify(
      buildHookSettings({
        runId: args.runId,
        hookToken: args.hookToken,
        baseUrl: args.baseUrl,
      }),
      null,
      2
    ),
    "utf8"
  );

  const command = buildClaudeCommand({
    claudeBin: claudeBin(),
    stateDir,
    sessionId: args.claudeSessionId,
  });

  // Clear a stale session from a previous run with the same id, then launch.
  await run(tmuxBin(), ["kill-session", "-t", session]);
  const launched = await run(tmuxBin(), [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "220",
    "-y",
    "50",
    "-c",
    args.cwd,
    command,
  ]);
  if (launched.code !== 0) {
    await rm(stateDir, { recursive: true, force: true });
    throw new Error(
      `tmux new-session failed (${launched.code}): ${launched.stderr || launched.stdout}`
    );
  }

  const startedAt = Date.now();
  const state = {
    waiter: deferred(),
    cancelled: false,
    stopSeen: false,
    deadline: startedAt + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    needsHuman: null as string | null,
    transcriptPath: null as string | null,
    tailOffset: 0,
    tailCarry: Buffer.alloc(0),
    seenUuids: new Set<string>(),
  };
  const firstDone = state.waiter.promise;

  const resolveDone = (d: ClaudeCliDone) => {
    if (d.kind === "stop") state.stopSeen = true;
    state.waiter.resolve(d);
  };

  const capturePane = async (): Promise<string> => {
    const res = await run(tmuxBin(), ["capture-pane", "-p", "-t", session]);
    return res.code === 0 ? res.stdout : "";
  };

  const paneTail = async (): Promise<string> => {
    const text = await capturePane();
    const lines = text.replace(/\s+$/, "").split("\n");
    return lines.slice(-40).join("\n");
  };

  // ── Pane poll: exit / killed / timeout / needs-human ──
  const poll = setInterval(() => {
    void (async () => {
      if (state.cancelled) return;

      const has = await run(tmuxBin(), ["has-session", "-t", session]);
      if (state.cancelled) return;
      if (has.code !== 0) {
        resolveDone({ kind: "killed" });
        return;
      }

      if (existsSync(exitFile)) {
        let exitCode = -1;
        try {
          exitCode = parseInt((await readFile(exitFile, "utf8")).trim(), 10);
          if (Number.isNaN(exitCode)) exitCode = -1;
        } catch {
          // keep -1
        }
        resolveDone({ kind: "exited", exitCode, paneTail: await paneTail() });
        return;
      }

      const pane = await capturePane();
      if (pane) {
        const reason = detectNeedsHuman(pane);
        if (reason && !state.needsHuman) {
          state.needsHuman = reason;
          args.onSystem("warning", {
            kind: "needs_human",
            reason,
            text: `Claude Code is waiting for human input (${reason}). Attach with: tmux attach -t ${session}`,
          });
        } else if (!reason && state.needsHuman) {
          state.needsHuman = null;
          args.onSystem("info", {
            kind: "needs_human_resolved",
            text: "Claude Code resumed after human input.",
          });
        }
      }

      if (Date.now() > state.deadline) {
        resolveDone({ kind: "timeout" });
      }
    })().catch(() => {});
  }, POLL_MS);

  // ── Transcript tailer ──
  const tail = setInterval(() => {
    void (async () => {
      if (state.cancelled) return;
      if (!state.transcriptPath) {
        if (Date.now() - startedAt < TRANSCRIPT_FALLBACK_MS) return;
        state.transcriptPath = computeTranscriptPath(args.cwd, args.claudeSessionId);
      }
      const path = state.transcriptPath;
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch {
        return; // not on disk yet
      }
      if (size < state.tailOffset) {
        // Truncated/rotated (shouldn't happen) — start over; uuid dedupe
        // keeps already-emitted messages from repeating.
        state.tailOffset = 0;
        state.tailCarry = Buffer.alloc(0);
      }
      if (size === state.tailOffset) return;

      let fh;
      try {
        fh = await open(path, "r");
        const len = size - state.tailOffset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, state.tailOffset);
        state.tailOffset = size;

        // Byte-accurate line assembly: only decode up to the last newline
        // so a multi-byte char straddling the read boundary can't corrupt.
        const acc = Buffer.concat([state.tailCarry, buf]);
        const lastNl = acc.lastIndexOf(0x0a);
        if (lastNl === -1) {
          state.tailCarry = acc;
          return;
        }
        state.tailCarry = Buffer.from(acc.subarray(lastNl + 1));
        const { entries } = parseTranscriptChunk(
          acc.subarray(0, lastNl + 1).toString("utf8"),
          ""
        );
        for (const entry of entries) {
          for (const env of mapTranscriptEntry(entry, {
            initialPrompt: args.prompt,
            seenUuids: state.seenUuids,
          })) {
            args.onEnvelope(env);
          }
        }
      } catch {
        // transient read error — retry next tick
      } finally {
        await fh?.close().catch(() => {});
      }
    })().catch(() => {});
  }, TAIL_MS);

  const handle: ClaudeCliHandle = {
    tmuxSession: session,
    attachHint: `tmux attach -t ${session}`,
    done: firstDone,

    hook(event, payload) {
      if (state.cancelled) return;
      if (event === "SessionStart") {
        const path = payload.transcript_path;
        if (typeof path === "string" && path) state.transcriptPath = path;
        return;
      }
      if (event === "Stop") {
        resolveDone({ kind: "stop" });
        return;
      }
      if (event === "SessionEnd") {
        // `/clear` also ends the session record but the process lives on.
        if (payload.reason === "clear") return;
        void paneTail().then((tailText) =>
          resolveDone({ kind: "exited", exitCode: 0, paneTail: tailText })
        );
      }
    },

    async nudge(text, waitMs) {
      const single = text.replace(/\s+/g, " ").trim();
      await run(tmuxBin(), ["send-keys", "-t", session, "-l", single]);
      await run(tmuxBin(), ["send-keys", "-t", session, "Enter"]);
      state.waiter = deferred();
      state.deadline = Date.now() + waitMs;
      return state.waiter.promise;
    },

    async cancel() {
      if (state.cancelled) return;
      state.cancelled = true;
      clearInterval(poll);
      clearInterval(tail);
      handles.delete(args.runId);
      await killTmuxSession(session).catch(() => {});
      if (!KEEP_DEBUG_STATE) {
        await rm(stateDir, { recursive: true, force: true }).catch(() => {});
      }
      // Unblock any pending awaiter so the worker never hangs on cancel.
      state.waiter.resolve({ kind: "killed" });
    },
  };

  handles.set(args.runId, handle);
  return handle;
}
