#!/usr/bin/env node
// scripts/worker-chat.ts
//
// Interactive CLI chat client for the worker WebSocket channel — a minimal,
// in-memory control plane for integration testing. It spawns a real
// `scripts/run-worker.ts` process per turn, dials its channel, performs the
// hello/accept handshake, pushes an authoritative `run.start` snapshot, streams
// transcript/agent events to the terminal, and answers the protocol's
// control-plane obligations (channel.ack, run.commit, tool.result stubs).
//
// The chat loop mirrors production dispatch: a `<chat>` worker processes its
// pending input, lands `run.phase: idle`, drains, and exits; every follow-up
// message respawns a fresh worker with `mode: "resume"`, the grown transcript,
// and the last checkpointed sdkSessionId. Nothing here touches Postgres.
//
// Usage:
//   npm run chat                            # interactive chat REPL
//   npm run chat -- --model anthropic/claude-sonnet-4-5
//   npm run chat -- --goal "summarize the README"   # single-turn run, then exit
//   npm run chat -- --cwd ../some-repo --profile read --verbose

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config as loadEnv } from "dotenv";
import WebSocket, { type RawData } from "ws";

// Load .env.local so the same knobs dispatch reads (agent credentials,
// TASK_ORCH_CLAUDE_HOME_HOST for the Docker ~/.claude auth mount, model
// defaults) are available to this stand-in control plane too.
loadEnv({ path: ".env.local" });

import {
  WORKER_CHANNEL_PROTOCOL,
  WORKER_CHANNEL_SUBPROTOCOL,
  type ChannelHello,
  type MessageSnapshot,
  type RunStart,
  type WireFrame,
  type WorkerEvent,
} from "../lib/worker-channel/protocol";
import { decodeFrame, encodeFrame, isTransportFrame, isWorkerEvent } from "../lib/worker-channel/codec";
import { newChannelInstanceId } from "../lib/worker-channel/credential";
import { localListenEndpoint, parseBoxHostUrl } from "../lib/worker-channel/dispatch-env";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── arguments ────────────────────────────────────────────────────────────────

/** Everything needed to dial a Box worker's hosted channel, discovered from the
 *  box id alone (see resolveBoxDial). The box IS the source of truth: its
 *  systemd unit carries the credential/instance/runId, and `host 8787` mints the
 *  public WSS URL + `_port_auth` token. */
interface BoxDial {
  wsUrl: string;
  credential: string;
  instanceId: string;
  token: string;
  runId: number;
}

interface CliArgs {
  model?: string;
  backend?: string;
  thinking?: string;
  profile?: string;
  cwd: string;
  cwdExplicit: boolean;
  runId: number;
  goal?: string;
  verbose: boolean;
  docker: boolean;
  image?: string;
  box?: string;
  boxDial?: BoxDial;
}

function usage(): never {
  console.log(`worker-chat — chat with a run worker over the WebSocket channel

  --model <provider/id>   model for the run (default: TASK_ORCH_CHAT_MODEL / TASK_ORCH_AGENT_MODEL)
  --backend <id>          agent backend (default: deployment default, e.g. "pi")
  --thinking <level>      thinking level passed to the backend
  --profile <spec>        toolsProfile string (default: none — always-on tools only)
  --cwd <dir>             working directory the agent operates in (default: current dir)
  --run-id <n>            synthetic run id (default: 424242)
  --goal <text>           single-turn mode: run one goal to completion and exit
  --box <id>              chat with a worker already running inside an ascii.dev Box.
                          Discovers the credential/instance/runId + hosted WSS URL
                          from the box itself; auto-resumes it if stopped.
  --docker                run the worker in a Docker container (channel over TCP)
  --image <ref>           worker image (default: TASK_ORCH_WORKER_IMAGE)
  -v, --verbose           show agent events, worker logs, and worker stderr
  -h, --help              this help

Interactive commands: /exit quits; Ctrl+C mid-turn cancels the turn.`);
  process.exit(0);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { cwd: process.cwd(), cwdExplicit: false, runId: 424242, verbose: false, docker: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      return value;
    };
    switch (flag) {
      case "--model": args.model = next(); break;
      case "--backend": args.backend = next(); break;
      case "--thinking": args.thinking = next(); break;
      case "--profile": args.profile = next(); break;
      case "--cwd": args.cwd = resolve(next()); args.cwdExplicit = true; break;
      case "--run-id": args.runId = parseInt(next(), 10); break;
      case "--goal": args.goal = next(); break;
      case "--docker": args.docker = true; break;
      case "--image": args.image = next(); break;
      case "--box": args.box = next(); break;
      case "-v": case "--verbose": args.verbose = true; break;
      case "-h": case "--help": usage();
      default: throw new Error(`unknown flag ${flag} (try --help)`);
    }
  }
  if (!Number.isInteger(args.runId) || args.runId <= 0) throw new Error("--run-id must be a positive integer");
  if (args.box && args.docker) throw new Error("--box and --docker are mutually exclusive");
  // A Docker worker has its own filesystem; a host --cwd is meaningless there.
  // /work is the image's per-run checkout dir, owned by the `node` user.
  if (args.docker && !args.cwdExplicit) args.cwd = "/work";
  return args;
}

// ── box discovery + dial ───────────────────────────────────────────────────────
//
// A Box worker is a long-lived systemd service (see scripts/box-setup.sh): it
// drains and exits after each turn, and systemd restarts it fresh — the same
// spawn-per-turn shape the local/docker paths model, except the process already
// exists. So --box mode never spawns; it dials the box's hosted WSS channel and
// hands the socket to the unchanged driveChannel REPL. Everything the control
// plane needs is discoverable from the box id, so that's the only argument.

const boxBin = (): string => process.env.BOX_BIN ?? join(homedir(), ".ascii", "bin", "box");
const execFileAsync = promisify(execFile);

async function boxCli(cliArgs: string[]): Promise<string> {
  const { stdout } = await execFileAsync(boxBin(), cliArgs, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const boxSsh = (id: string, remote: string): Promise<string> => boxCli(["ssh", id, remote]);

/** Pull the channel identity a Box worker was launched with out of its systemd
 *  unit. Pure so it can be unit-tested without a live box. */
export function parseWorkerUnitEnv(unit: string): { credential: string; instanceId: string; runId: number } {
  const credential = unit.match(/TASK_ORCH_WORKER_CHANNEL_CREDENTIAL=(\S+)/)?.[1];
  const instanceId = unit.match(/TASK_ORCH_WORKER_INSTANCE_ID=(\S+)/)?.[1];
  const runId = unit.match(/run-worker\.ts\s+(\d+)/)?.[1];
  if (!credential || !instanceId || !runId) {
    throw new Error(
      "task-orch-worker.service is missing the channel credential/instance/runId — " +
        "is this box provisioned by scripts/box-setup.sh?",
    );
  }
  return { credential, instanceId, runId: Number(runId) };
}

// A reachable box reports one of these; "stopped" needs a resume, and
// "resuming"/other transitional states just need polling.
const BOX_UP_STATES = new Set(["ready", "idle", "running"]);

const boxState = (raw: string): string => {
  const parsed = JSON.parse(raw) as { state?: string; box?: { state?: string } };
  return parsed.box?.state ?? parsed.state ?? "unknown";
};

/** Read the box's state and resume it if it's stopped, then wait until it's up. */
async function ensureBoxReady(id: string): Promise<void> {
  const state = boxState(await boxCli(["info", id, "--json"]));
  if (BOX_UP_STATES.has(state)) return;
  if (state === "stopped") {
    console.log(dim(`box ${id} is stopped; resuming…`));
    await boxCli(["resume", id]);
  } else {
    console.log(dim(`box ${id} is ${state}; waiting for it to come up…`));
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (BOX_UP_STATES.has(boxState(await boxCli(["info", id, "--json"])))) return;
    if (Date.now() > deadline) throw new Error(`box ${id} did not come up within 120s`);
    await delay(2_000);
  }
}

/** Discover everything needed to dial a Box worker from the box id alone. */
async function resolveBoxDial(id: string): Promise<BoxDial> {
  await ensureBoxReady(id);

  const unit = await boxSsh(id, "cat /etc/systemd/system/task-orch-worker.service 2>/dev/null");
  const { credential, instanceId, runId } = parseWorkerUnitEnv(unit);

  // The worker may still be (re)starting; wait for it to bind the channel port.
  console.log(dim("waiting for the box worker to listen on :8787…"));
  const bound = await boxSsh(
    id,
    "for i in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ':8787 ' && { echo up; break; }; sleep 1; done",
  );
  if (!/\bup\b/.test(bound)) {
    throw new Error("box worker never bound :8787 (check `box ssh " + id + " sudo journalctl -u task-orch-worker`)");
  }

  // `host 8787` registers (or re-returns) the public WSS reverse proxy + token.
  const hostOut = await boxSsh(id, "/home/user/.ascii/host 8787 --title task-orch-worker-channel 2>&1");
  const parsed = parseBoxHostUrl(hostOut);
  if (!parsed) throw new Error(`could not parse a hosted URL from \`host 8787\`: ${truncate(hostOut, 200)}`);
  const wsUrl = `${parsed.origin.replace(/^http/i, "ws")}/worker/channel`;
  return { wsUrl, credential, instanceId, token: parsed.token, runId };
}

/** Dial a Box worker's hosted channel with a bounded boot backoff: after each
 *  turn the worker exits and systemd restarts it, so the proxy briefly 502s
 *  until the new process re-binds. The `_token` rides as the proxy's
 *  `_port_auth` cookie (a `?_token=` query would 302), alongside the worker's
 *  own bearer credential. */
async function dialBoxWorker(dial: BoxDial): Promise<WebSocket> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    const sock = new WebSocket(dial.wsUrl, [WORKER_CHANNEL_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${dial.credential}`, Cookie: `_port_auth=${dial.token}` },
      handshakeTimeout: 15_000,
    });
    const opened = await new Promise<boolean>((res) => {
      sock.once("open", () => res(true));
      sock.once("unexpected-response", () => res(false));
      sock.once("error", () => res(false));
    });
    if (opened) return sock;
    try {
      sock.terminate();
    } catch {
      /* already closed */
    }
    if (Date.now() > deadline) throw new Error(`timed out dialing box worker at ${dial.wsUrl}`);
    await delay(Math.min(500 * 2 ** attempt, 5_000));
  }
}

// ── terminal helpers ─────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s);

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── transcript rendering ─────────────────────────────────────────────────────

function renderContentBlock(block: unknown, verbose: boolean): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return typeof b.text === "string" && b.text.trim() ? b.text.trim() : null;
    case "thinking":
      return verbose && typeof b.thinking === "string" && b.thinking.trim()
        ? dim(`(thinking) ${truncate(b.thinking.trim(), 400)}`)
        : null;
    case "tool_use":
    case "toolCall": {
      const name = (b.name ?? b.tool ?? "?") as string;
      const input = b.input ?? b.arguments ?? {};
      return dim(`⚙ ${name} ${truncate(JSON.stringify(input), 160)}`);
    }
    case "tool_result": {
      const inner = Array.isArray(b.content)
        ? b.content
            .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
            .join("")
        : typeof b.content === "string"
          ? b.content
          : JSON.stringify(b.content ?? "");
      const marker = b.is_error ? red("✗") : dim("→");
      return dim(`${marker} ${truncate(inner.trim() || "(empty result)", 200)}`);
    }
    default:
      return verbose ? dim(`(${String(b.type)}) ${truncate(JSON.stringify(b), 160)}`) : null;
  }
}

function printTranscriptMessage(message: MessageSnapshot, verbose: boolean): void {
  for (const block of message.content) {
    const line = renderContentBlock(block, verbose);
    if (line === null) continue;
    if (message.role === "agent" && (block as { type?: string }).type === "text") {
      console.log(`${cyan(bold("agent>"))} ${line}`);
    } else {
      console.log(`  ${line}`);
    }
  }
}

// ── Ctrl+C routing ───────────────────────────────────────────────────────────
//
// While readline owns the TTY (raw mode), Ctrl+C never reaches process-level
// SIGINT listeners — it fires on the readline interface instead. Both paths
// route through this holder: mid-turn it points at the turn's cancel action,
// otherwise the interactive prompt handler exits the process.
const sigint: { onTurn: (() => void) | null } = { onTurn: null };

// Never leave a worker running past the CLI: an exit mid-turn (second Ctrl+C,
// crash) would otherwise strand the child until its own disconnect grace.
// Killing the attached `docker run` client does NOT stop the container, so a
// Docker worker additionally needs a force-remove by name.
let liveWorker: ChildProcess | null = null;
let liveContainer: string | null = null;
process.on("exit", () => {
  if (liveWorker && liveWorker.exitCode === null) liveWorker.kill("SIGKILL");
  if (liveContainer) spawnSync("docker", ["rm", "-f", liveContainer], { stdio: "ignore" });
});

// ── chat session state ───────────────────────────────────────────────────────

class ChatState {
  readonly transcript: MessageSnapshot[] = [];
  sdkSessionId: string | null = null;
  turns = 0;
  private nextId = 0;

  message(role: MessageSnapshot["role"], content: unknown[]): MessageSnapshot {
    return { id: ++this.nextId, role, content, createdAt: new Date().toISOString() };
  }

  userMessage(text: string): MessageSnapshot {
    return this.message("user", [{ type: "text", text }]);
  }
}

// ── one worker turn ──────────────────────────────────────────────────────────

interface TurnConfig {
  args: CliArgs;
  state: ChatState;
  /** The fresh user message for this turn (chat mode), or none (goal mode). */
  pendingInput: MessageSnapshot[];
}

function buildRunStart(config: TurnConfig): RunStart {
  const { args, state, pendingInput } = config;
  const model = args.model ?? process.env.TASK_ORCH_CHAT_MODEL ?? process.env.TASK_ORCH_AGENT_MODEL;
  return {
    mode: state.turns === 0 ? "start" : "resume",
    run: {
      id: args.runId,
      status: "running",
      goal: args.goal ?? "<chat>",
      ...(model ? { model } : {}),
      ...(args.backend ? { backend: args.backend } : {}),
      ...(args.thinking ? { thinkingLevel: args.thinking } : {}),
      ...(args.profile ? { toolsProfile: args.profile } : {}),
      ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
      worktreePath: args.cwd,
      taskId: null,
      planId: null,
      completedAt: null,
    },
    task: null,
    plan: null,
    persona: { id: "cli-harness", name: "worker-chat" },
    repository: { id: "cli-harness", localPath: args.cwd, remote: null },
    transcript: [...state.transcript],
    inboxDigest: null,
    memoryContext: "",
    pendingInput: [...pendingInput],
    policy: { allowedTools: [], maxTurns: null, deadline: null },
    ...(args.goal && state.turns === 0 ? { kickoffPrompt: args.goal } : {}),
  };
}

interface TurnOutcome {
  /** Terminal event type when the worker proposed one ("run.finished" etc.). */
  terminal?: string;
  error?: string;
}

/** Spawn one worker, drive one turn over its channel, and stream the output.
 *  Resolves when the worker's socket closes (clean drain or otherwise). */
async function runTurn(config: TurnConfig): Promise<TurnOutcome> {
  const { args, state } = config;

  // Box mode: the worker already exists on the box; dial it, drive one turn,
  // and let it drain+exit (systemd restarts it before the next turn). No child.
  if (args.boxDial) {
    try {
      const socket = await dialBoxWorker(args.boxDial);
      return await driveChannel(socket, config, args.boxDial.instanceId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const instanceId = newChannelInstanceId();
  const credential = `cli.${randomBytes(24).toString("base64url")}`;
  const containerName = args.docker ? `worker-chat-${process.pid}-${state.turns}` : null;

  let child: ChildProcess;
  let dialUrl: string | null = null; // Docker discovers its published port after start.
  if (containerName) {
    // Docker worker: same env shape as production dispatch
    // (buildWorkerContainerConfig), except the channel port is published to
    // localhost — on macOS the host cannot reach a container's bridge IP, and
    // this harness has no compose network to share.
    const image = args.image ?? process.env.TASK_ORCH_WORKER_IMAGE ?? "task-orchestrator-worker:dev";
    const claudeHome = process.env.TASK_ORCH_CLAUDE_HOME_HOST;
    child = spawn(
      "docker",
      [
        "run", "--rm", "--name", containerName,
        "-p", "127.0.0.1::8787",
        "-e", `TASK_ORCH_WORKER_INSTANCE_ID=${instanceId}`,
        "-e", `TASK_ORCH_WORKER_CHANNEL_CREDENTIAL=${credential}`,
        "-e", "TASK_ORCH_WORKER_CHANNEL_ENDPOINT=tcp:0.0.0.0:8787",
        "-e", "TASK_ORCH_INSIDE_WORKER=1",
        "-e", "TASK_ORCH_DETACHED_RUNS=1",
        // The durable outbox spools to $SESSION_ROOT/channel. The image's
        // WORKDIR /app is root-owned but the worker runs as `node`, so the cwd
        // default (process.cwd() => /app) fails mkdir with EACCES. /work is
        // chowned to node in the Dockerfile for exactly this. NOTE: production
        // buildWorkerContainerConfig omits SESSION_ROOT entirely — the Docker
        // path has never been exercised live and hits this same wall.
        "-e", "SESSION_ROOT=/work",
        ...(claudeHome
          ? ["-v", `${claudeHome}:/home/node/.claude`, "-v", `${claudeHome}.json:/home/node/.claude.json`]
          : []),
        image,
        String(args.runId),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    liveContainer = containerName;
  } else {
    // Local worker over a Unix socket.
    // The spool under SESSION_ROOT is scoped to one run+instance — a fresh
    // worker instance must get a fresh root or WorkerSession.open refuses it.
    const scratch = join(tmpdir(), "worker-chat", `${process.pid}-${state.turns}`);
    mkdirSync(scratch, { recursive: true });
    // Unix socket paths are capped near 104 bytes on darwin — keep this short.
    const socketPath = join(tmpdir(), `wc-${process.pid}-${state.turns}.sock`);
    child = spawn(join(repoRoot, "node_modules", ".bin", "tsx"), ["scripts/run-worker.ts", String(args.runId)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TASK_ORCH_WORKER_INSTANCE_ID: instanceId,
        TASK_ORCH_WORKER_CHANNEL_CREDENTIAL: credential,
        TASK_ORCH_WORKER_CHANNEL_ENDPOINT: localListenEndpoint(socketPath),
        // Keep the durable spool out of the repo checkout.
        SESSION_ROOT: scratch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    dialUrl = `ws+unix://${socketPath}:/worker/channel`;
  }
  liveWorker = child;

  const stderrTail: string[] = [];
  const onChildOutput = (chunk: Buffer, stream: "out" | "err") => {
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      if (stream === "err") {
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
      }
      if (args.verbose) console.log(dim(`[worker:${stream}] ${line}`));
    }
  };
  child.stdout!.on("data", (c: Buffer) => onChildOutput(c, "out"));
  child.stderr!.on("data", (c: Buffer) => onChildOutput(c, "err"));

  const childExit = new Promise<number | null>((res) => child.once("exit", (code) => res(code)));

  try {
    if (containerName) dialUrl = `ws://127.0.0.1:${await discoverContainerPort(containerName, child)}/worker/channel`;
    const socket = await dialWorker(dialUrl!, credential, child);
    return await driveChannel(socket, config, instanceId);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    // Belt and braces: the worker exits on clean drain by itself.
    const code = await Promise.race([childExit, delay(10_000).then(() => null)]);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    if (containerName) spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    liveWorker = null;
    liveContainer = null;
    if (code !== 0 && code !== null && !args.verbose && stderrTail.length > 0) {
      console.error(red(`worker exited with code ${code}; last stderr:`));
      for (const line of stderrTail.slice(-15)) console.error(dim(`  ${line}`));
    }
  }
}

/** Poll `docker port` until the container's published channel port appears. */
async function discoverContainerPort(containerName: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`docker run exited (code ${child.exitCode}) before the container started`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${containerName}'s published port`);
    const output = await new Promise<string>((res) =>
      execFile("docker", ["port", containerName, "8787/tcp"], (err, stdout) => res(err ? "" : stdout))
    );
    const match = output.match(/:(\d+)\s*$/m);
    if (match) return Number(match[1]);
    await delay(300);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Dial the worker's channel (Unix socket or TCP), retrying until it binds. */
async function dialWorker(endpoint: string, credential: string, child: ChildProcess): Promise<WebSocket> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`worker exited (code ${child.exitCode}) before its channel came up`);
    if (Date.now() > deadline) throw new Error(`timed out dialing ${endpoint}`);
    const attempt = new WebSocket(endpoint, [WORKER_CHANNEL_SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${credential}` },
      handshakeTimeout: 5_000,
    });
    const opened = await new Promise<boolean>((res) => {
      attempt.once("open", () => res(true));
      attempt.once("error", () => res(false));
    });
    if (opened) return attempt;
    attempt.terminate();
    await delay(250);
  }
}

/** The full channel conversation for one worker: handshake, run.start, event
 *  streaming, acks, tool stubs, and the terminal run.commit reply. */
async function driveChannel(socket: WebSocket, config: TurnConfig, instanceId: string): Promise<TurnOutcome> {
  const { args, state } = config;
  const controllerEpoch = 1;
  let controlSeq = 0;
  const outcome: TurnOutcome = {};

  // Serialized frame queue: the worker speaks first (channel.hello can share
  // the TCP segment with the 101 response), so buffer from the very first tick.
  const inbox: WireFrame[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let closeInfo = { code: 0, reason: "" };
  socket.on("message", (data: RawData) => {
    try {
      inbox.push(decodeFrame(Array.isArray(data) ? Buffer.concat(data) : data));
    } catch (error) {
      console.error(red(`undecodable frame: ${error instanceof Error ? error.message : String(error)}`));
    }
    wake?.();
  });
  socket.on("close", (code: number, reason: Buffer) => {
    closed = true;
    closeInfo = { code, reason: reason.toString("utf8") };
    wake?.();
  });
  socket.on("error", () => undefined);

  const nextFrame = async (): Promise<WireFrame | null> => {
    for (;;) {
      const frame = inbox.shift();
      if (frame) return frame;
      if (closed) return null;
      await new Promise<void>((res) => {
        wake = res;
      });
      wake = null;
    }
  };

  const send = (frame: WireFrame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeFrame(frame));
  };
  const sendCommand = (type: string, payload: unknown, replyTo?: string) =>
    send({
      v: WORKER_CHANNEL_PROTOCOL,
      type,
      id: randomUUID(),
      runId: args.runId,
      instanceId,
      controllerEpoch,
      seq: ++controlSeq,
      sentAt: new Date().toISOString(),
      ...(replyTo ? { replyTo } : {}),
      payload,
    } as WireFrame);

  // 1) handshake
  const first = await nextFrame();
  if (!first || first.type !== "channel.hello") {
    throw new Error(`expected channel.hello, got ${first ? first.type : `close (${closeInfo.code} ${closeInfo.reason})`}`);
  }
  const hello = first.payload as ChannelHello;
  if (hello.protocol.min > WORKER_CHANNEL_PROTOCOL || hello.protocol.max < WORKER_CHANNEL_PROTOCOL) {
    throw new Error(`worker protocol range ${hello.protocol.min}..${hello.protocol.max} excludes v${WORKER_CHANNEL_PROTOCOL}`);
  }
  send({
    v: WORKER_CHANNEL_PROTOCOL,
    type: "channel.accept",
    seq: 0,
    payload: {
      protocol: WORKER_CHANNEL_PROTOCOL,
      controllerEpoch,
      leaseId: `cli-${randomUUID()}`,
      lastAcceptedWorkerSeq: 0,
      heartbeatMs: 10_000,
      disconnectGraceMs: 60_000,
      maxInFlightBytes: 8_388_608,
    },
  } as WireFrame);

  // 2) authoritative snapshot
  sendCommand("run.start", buildRunStart(config));

  // Keep the socket visibly alive for long model turns.
  const pinger = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, 10_000);
  pinger.unref?.();

  // Ctrl+C mid-turn cancels the run; a second Ctrl+C quits outright. Register
  // on the shared holder (readline delivers TTY Ctrl+C there) AND on the
  // process (goal mode has no readline, so the raw signal arrives here).
  const onSigint = () => {
    console.log(yellow("\n(cancelling turn — Ctrl+C again to quit)"));
    sendCommand("run.cancel", { reason: "user interrupt", requestId: randomUUID(), deadline: null });
    sigint.onTurn = () => process.exit(130);
  };
  sigint.onTurn = onSigint;
  process.once("SIGINT", onSigint);

  const ack = (event: WorkerEvent) =>
    send({
      v: WORKER_CHANNEL_PROTOCOL,
      type: "channel.ack",
      id: randomUUID(),
      runId: args.runId,
      instanceId,
      controllerEpoch,
      seq: 0,
      sentAt: new Date().toISOString(),
      payload: { throughSeq: event.seq },
    } as WireFrame);

  try {
    // 3) event loop until the worker drains
    for (;;) {
      const frame = await nextFrame();
      if (frame === null) break;
      if (isTransportFrame(frame)) continue; // worker acks of our commands
      if (!isWorkerEvent(frame)) {
        console.error(red(`unexpected frame ${frame.type} from worker`));
        continue;
      }
      const event = frame;
      switch (event.type) {
        case "run.ready":
          if (args.verbose) console.log(dim("· run.ready"));
          break;
        case "run.phase": {
          const { phase, detail } = event.payload;
          console.log(dim(`· phase: ${phase}${detail ? ` (${detail})` : ""}`));
          break;
        }
        case "transcript.append": {
          const message = event.payload.message;
          // Re-key onto our monotonic id space and grow the resume transcript.
          const stored = state.message(message.role, message.content);
          state.transcript.push(stored);
          printTranscriptMessage(stored, args.verbose);
          break;
        }
        case "agent.event":
          if (args.verbose) console.log(dim(`· agent.event ${truncate(JSON.stringify(event.payload.event), 200)}`));
          break;
        case "run.checkpoint":
          if (event.payload.sdkSessionId) state.sdkSessionId = event.payload.sdkSessionId;
          if (args.verbose) console.log(dim(`· checkpoint (sdkSessionId: ${event.payload.sdkSessionId ?? "none"})`));
          break;
        case "tool.invoke": {
          const { callId, tool } = event.payload;
          console.log(yellow(`⚙ tool.invoke ${tool} ${truncate(JSON.stringify(event.payload.arguments), 160)}`));
          sendCommand("tool.accepted", { callId });
          sendCommand(
            "tool.result",
            {
              callId,
              result: {
                content: [
                  { type: "text", text: `The '${tool}' tool is not available in this CLI test harness; continue without it.` },
                ],
                isError: true,
              },
              isError: true,
            },
            event.id
          );
          break;
        }
        case "run.finished":
          outcome.terminal = "run.finished";
          console.log(bold(`\n✔ run finished`) + (typeof event.payload.result === "string" ? `: ${event.payload.result}` : ""));
          if (event.payload.usage) console.log(dim(`  usage: ${JSON.stringify(event.payload.usage)}`));
          sendCommand("run.commit", { status: "completed", result: event.payload.result, usage: event.payload.usage }, event.id);
          break;
        case "run.failed":
          outcome.terminal = "run.failed";
          outcome.error = event.payload.error;
          console.error(red(`\n✘ run failed: ${event.payload.error}`));
          sendCommand("run.commit", { status: "failed", error: event.payload.error }, event.id);
          break;
        case "run.cancelled":
          outcome.terminal = "run.cancelled";
          console.log(yellow(`\n■ run cancelled${event.payload.reason ? `: ${event.payload.reason}` : ""}`));
          sendCommand("run.commit", { status: "cancelled" }, event.id);
          break;
        case "worker.log": {
          for (const entry of event.payload.entries) {
            const level = (entry.level ?? "info").toLowerCase();
            if (args.verbose || level === "error" || level === "warn") {
              console.log(dim(`[worker.log:${level}] ${entry.message}`));
            }
          }
          break;
        }
        case "blob.open":
          sendCommand("blob.rejected", { blobId: event.payload.blobId, reason: "cli harness does not accept blobs" });
          break;
        case "blob.accepted":
        case "blob.rejected":
          break;
        default:
          if (args.verbose) console.log(dim(`· ${String((event as WorkerEvent).type)}`));
      }
      ack(event);
    }
  } finally {
    clearInterval(pinger);
    sigint.onTurn = null;
    process.removeListener("SIGINT", onSigint);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "cli done");
  }

  if (closeInfo.code !== 1000 && closeInfo.code !== 0) {
    console.log(dim(`· channel closed (${closeInfo.code}${closeInfo.reason ? ` ${closeInfo.reason}` : ""})`));
  }
  state.turns += 1;
  return outcome;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const state = new ChatState();

  if (args.box) {
    console.log(dim(`resolving box ${args.box}…`));
    args.boxDial = await resolveBoxDial(args.box);
    args.runId = args.boxDial.runId; // the box's worker is pinned to this run id
    if (!args.cwdExplicit) args.cwd = "/home/user/nodetool";
    console.log(dim(`box worker ready — dialing ${args.boxDial.wsUrl} (runId ${args.runId})`));
  }

  if (args.goal) {
    console.log(dim(`running goal against worker (runId ${args.runId}, cwd ${args.cwd})…`));
    const outcome = await runTurn({ args, state, pendingInput: [] });
    process.exit(outcome.terminal === "run.finished" ? 0 : 1);
  }

  console.log(bold("worker-chat") + dim(` — runId ${args.runId}, cwd ${args.cwd}. /exit to quit.`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    // Readline swallows TTY Ctrl+C: route it to the in-flight turn's cancel
    // action when one exists, else quit cleanly from the prompt.
    if (sigint.onTurn) {
      sigint.onTurn();
      return;
    }
    rl.close();
    process.exit(0);
  });

  // Buffer lines instead of rl.question(): piped input delivers every line up
  // front, and readline DROPS lines that arrive while no question is pending —
  // which is exactly when a turn is running.
  const lines: string[] = [];
  let lineWake: (() => void) | null = null;
  let stdinClosed = false;
  rl.on("line", (line) => {
    lines.push(line);
    lineWake?.();
  });
  rl.on("close", () => {
    stdinClosed = true;
    lineWake?.();
  });
  const nextLine = async (): Promise<string | null> => {
    for (;;) {
      const line = lines.shift();
      if (line !== undefined) return line;
      if (stdinClosed) return null;
      await new Promise<void>((res) => {
        lineWake = res;
      });
      lineWake = null;
    }
  };

  for (;;) {
    process.stdout.write(bold("you> "));
    const line = await nextLine();
    if (line === null) break; // stdin closed
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;

    const userMessage = state.userMessage(text);
    const outcome = await runTurn({ args, state, pendingInput: [userMessage] });
    state.transcript.push(userMessage);
    // Keep transcript ordering: the user message must precede this turn's agent
    // replies. runTurn appended agent messages after we allocated the user id,
    // so ids are already ordered; sort defensively for the next snapshot.
    state.transcript.sort((a, b) => a.id - b.id);
    if (outcome.error && !outcome.terminal) console.error(red(`turn error: ${outcome.error}`));
  }

  rl.close();
}

// Run only when executed directly (`tsx scripts/worker-chat.ts`), not when a
// test imports this module for its pure helpers (parseWorkerUnitEnv).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(red(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    process.exit(1);
  });
}
