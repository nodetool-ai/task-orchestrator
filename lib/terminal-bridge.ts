// lib/terminal-bridge.ts
//
// Manages a tmux pane stream per session. Multiple WebSocket clients share
// one bridge; the first client starts pipe-pane and subsequent clients get
// a full replay of all captured bytes (so xterm.js reconstructs the correct
// terminal state) followed by live bytes from the ongoing stream.
//
// Stored on globalThis so HMR module replacement in `next dev` doesn't drop
// an active stream.

import { spawn } from "node:child_process";
import { mkdir, open, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAIL_MS = 100;

type BroadcastFn = (data: Buffer) => void;

interface Bridge {
  session: string;
  paneFile: string;
  /** All bytes captured since the bridge was created (for replay to late joiners). */
  history: Buffer[];
  /** Total bytes in history (tail of all Buffers). */
  historySize: number;
  clients: Set<BroadcastFn>;
  tailOffset: number;
  tailInterval: ReturnType<typeof setInterval>;
}

declare global {
  // eslint-disable-next-line no-var
  var __terminalBridges: Map<string, Bridge> | undefined;
}

const bridges: Map<string, Bridge> =
  globalThis.__terminalBridges ?? new Map();
if (!globalThis.__terminalBridges) globalThis.__terminalBridges = bridges;

async function tmuxRun(
  args: string[]
): Promise<{ code: number | null; stdout: string }> {
  const bin = process.env.TASK_ORCH_TMUX_BIN || "tmux";
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.on("close", (code) => resolve({ code, stdout }));
    child.on("error", () => resolve({ code: null, stdout }));
    setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout });
    }, 10_000);
  });
}

async function createBridge(tmuxSession: string): Promise<Bridge> {
  const paneDir = join(tmpdir(), "task-orch");
  await mkdir(paneDir, { recursive: true });
  const paneFile = join(paneDir, `pane-${tmuxSession}.out`);

  // Seed: current screen snapshot with ANSI codes. Claude Code's TUI redraws
  // frequently so xterm.js self-corrects quickly after any mismatch.
  const seed = await tmuxRun([
    "capture-pane",
    "-e",
    "-p",
    "-t",
    tmuxSession,
  ]);
  const seedBytes =
    seed.code === 0 && seed.stdout
      ? Buffer.from(`\x1b[2J\x1b[H${seed.stdout}`, "utf8")
      : Buffer.alloc(0);

  // Pipe all future output to the file (idempotent per session).
  await tmuxRun([
    "pipe-pane",
    "-t",
    tmuxSession,
    "-o",
    `cat >> '${paneFile}'`,
  ]);

  const bridge: Bridge = {
    session: tmuxSession,
    paneFile,
    history: seedBytes.length > 0 ? [seedBytes] : [],
    historySize: seedBytes.length,
    clients: new Set(),
    tailOffset: 0,
    tailInterval: setInterval(() => {
      void tailOnce(bridge).catch(() => {});
    }, TAIL_MS),
  };

  return bridge;
}

async function tailOnce(bridge: Bridge): Promise<void> {
  if (bridge.clients.size === 0) return;
  if (!existsSync(bridge.paneFile)) return;

  let size: number;
  try {
    size = (await stat(bridge.paneFile)).size;
  } catch {
    return;
  }
  if (size <= bridge.tailOffset) return;

  let fh;
  try {
    fh = await open(bridge.paneFile, "r");
    const len = size - bridge.tailOffset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, bridge.tailOffset);
    if (bytesRead <= 0) return;
    const chunk = buf.subarray(0, bytesRead);
    bridge.tailOffset += bytesRead;
    bridge.history.push(chunk);
    bridge.historySize += bytesRead;
    for (const send of bridge.clients) {
      try {
        send(chunk);
      } catch {
        // ignore dead client; ws.on("close") will remove it
      }
    }
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function destroyBridge(tmuxSession: string): Promise<void> {
  const bridge = bridges.get(tmuxSession);
  if (!bridge) return;
  clearInterval(bridge.tailInterval);
  bridges.delete(tmuxSession);
  await tmuxRun(["pipe-pane", "-t", tmuxSession]).catch(() => {});
}

/**
 * Attach a new WebSocket client to the tmux pane stream.
 * Returns a detach function to call when the client disconnects.
 */
export async function attachToSession(
  tmuxSession: string,
  send: BroadcastFn
): Promise<() => Promise<void>> {
  let bridge = bridges.get(tmuxSession);
  if (!bridge) {
    bridge = await createBridge(tmuxSession);
    bridges.set(tmuxSession, bridge);
  }

  // Add to clients before sending history so the tailer can't deliver a chunk
  // between the history dump and the add (in JS's single-threaded event loop
  // we won't be preempted here, but belt-and-suspenders).
  bridge.clients.add(send);

  // Replay all history so xterm.js arrives at the current terminal state.
  if (bridge.historySize > 0) {
    const replay = Buffer.concat(bridge.history);
    try {
      send(replay);
    } catch {
      bridge.clients.delete(send);
      return async () => {};
    }
  }

  return async () => {
    bridge!.clients.delete(send);
    if (bridge!.clients.size === 0) {
      await destroyBridge(tmuxSession);
    }
  };
}

/** Send raw input bytes to the tmux session (handles control sequences). */
export async function sendInput(
  tmuxSession: string,
  data: string
): Promise<void> {
  // Hex-encode every byte so tmux send-keys -H interprets them correctly,
  // including Escape sequences (arrow keys, Ctrl+C, etc.).
  const bytes = Buffer.from(data, "utf8");
  const hex = bytes.toString("hex").match(/.{2}/g)?.join(" ") ?? "";
  if (hex) {
    await tmuxRun(["send-keys", "-t", tmuxSession, "-H", hex]);
  }
}

/** Resize the tmux window (shrinks/grows the pane seen by the TUI). */
export async function resizeSession(
  tmuxSession: string,
  cols: number,
  rows: number
): Promise<void> {
  await tmuxRun([
    "resize-window",
    "-t",
    tmuxSession,
    "-x",
    String(Math.max(1, cols)),
    "-y",
    String(Math.max(1, rows)),
  ]);
}

/** True if the tmux session still exists. */
export async function isSessionAlive(tmuxSession: string): Promise<boolean> {
  const r = await tmuxRun(["has-session", "-t", tmuxSession]);
  return r.code === 0;
}
