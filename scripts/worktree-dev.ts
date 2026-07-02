// Start this worktree's dev server — the simple, secure way.
//
//   npm run worktree-dev               # loopback only (default)
//   npm run worktree-dev -- --tunnel   # also open a secure HTTPS tunnel
//   npm run worktree-dev -- --port 3456
//   npm run worktree-dev -- --host 0.0.0.0   # opt in to a raw network bind (discouraged)
//
// Security model — secure by default:
//   - Binds 127.0.0.1 only (NOT 0.0.0.0), so the server is never exposed on a
//     network interface directly. Other worktrees on the host can't reach it
//     and nothing off-host can either.
//   - The app itself sits behind NextAuth login (AUTH_SECRET), so even once
//     reached, it requires authentication.
//   - Each worktree gets a deterministic, collision-free port (see
//     preferredDevPort) so concurrent worktrees don't fight over port 3000 and
//     each keeps a stable URL across restarts.
//   - `--tunnel` exposes the loopback server over a Cloudflare quick tunnel
//     (`cloudflared tunnel --url`), yielding a random, unguessable HTTPS
//     *.trycloudflare.com URL — matches the prod Cloudflare setup. The tunnel
//     fronts the *loopback* port; we never widen the bind to do it. cloudflared
//     is auto-installed into a shared cache on first use (see lib/cloudflared).
//
// The tunnel needs outbound egress to Cloudflare's edge (argotunnel.com): QUIC
// over UDP/7844 by default. If your network blocks UDP, set
// CLOUDFLARED_PROTOCOL=http2 to use TCP instead. Pin the binary with
// CLOUDFLARED_VERSION or point at your own with CLOUDFLARED_PATH.
//
// To reach a loopback-only server from your machine, use your platform's
// port-forwarding (e.g. an SSH tunnel: `ssh -L <port>:127.0.0.1:<port> host`)
// or pass --tunnel for a shareable URL.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { preferredDevPort, DEV_PORT_SPAN } from "../lib/worktree-env";
import { resolveCloudflared } from "../lib/cloudflared";

interface Args {
  tunnel: boolean;
  host: string;
  port: number | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { tunnel: false, host: "127.0.0.1", port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tunnel") out.tunnel = true;
    else if (a === "--host") out.host = argv[++i] ?? out.host;
    else if (a.startsWith("--host=")) out.host = a.slice("--host=".length);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
  }
  if (out.port !== null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    console.error(`Invalid --port: ${out.port}`);
    process.exit(1);
  }
  return out;
}

/** True when nothing is already listening on host:port. */
function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once("error", () => res(false));
    srv.once("listening", () => srv.close(() => res(true)));
    srv.listen(port, host);
  });
}

/** First free port at or after `start`, scanning within the dev range. */
async function findFreePort(start: number, host: string): Promise<number> {
  for (let i = 0; i < DEV_PORT_SPAN; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await portIsFree(port, host)) return port;
  }
  throw new Error(`No free port found near ${start} on ${host}`);
}

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();

const preferred = args.port ?? preferredDevPort(cwd);
const port = await findFreePort(preferred, args.host);
if (port !== preferred) {
  console.log(`Port ${preferred} busy — using ${port} instead.`);
}

if (args.host !== "127.0.0.1" && args.host !== "localhost") {
  console.warn(
    `⚠ Binding ${args.host} exposes this dev server beyond loopback. Prefer the default 127.0.0.1 + --tunnel for secure remote access.`
  );
}

const localUrl = `http://127.0.0.1:${port}`;
console.log(`Starting dev server for this worktree → ${args.host}:${port}`);
console.log(`Local:   ${localUrl}  (behind NextAuth login)`);

const children: ChildProcess[] = [];

// Tear the whole group down together: if one child dies, stop the rest, and
// forward Ctrl-C / termination so nothing is orphaned.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals | null, code: number | null) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c.killed) c.kill(signal ?? "SIGTERM");
  }
  process.exit(code ?? 0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => shutdown(sig, 0));
}

// Register a child for group shutdown and wire its exit/error handlers
// IMMEDIATELY — not in a trailing loop. `await resolveCloudflared()` below can
// spend seconds downloading a binary; a child that dies (or fails to spawn:
// ENOENT emits 'error') during that window must still trigger shutdown rather
// than being lost or crashing the process on an unhandled 'error'.
function track(child: ChildProcess): void {
  children.push(child);
  child.on("exit", (code) => shutdown(null, code ?? 0));
  child.on("error", (err) => {
    console.error(`Child process error: ${err.message}`);
    shutdown("SIGTERM", 1);
  });
}

track(
  spawn("npx", ["next", "dev", "-H", args.host, "-p", String(port)], {
    cwd,
    stdio: "inherit",
    env: process.env,
  })
);

if (args.tunnel) {
  try {
    const cf = await resolveCloudflared();
    if (cf.source === "download") {
      console.log("Installed cloudflared into the shared cache.");
    }
    console.log("Opening Cloudflare quick tunnel (watch below for the https URL)…");
    // The tunnel data plane needs outbound egress to Cloudflare's edge
    // (argotunnel.com): QUIC over UDP/7844, or TCP when forced to HTTP/2. On
    // networks that block UDP, set CLOUDFLARED_PROTOCOL=http2 to skip QUIC.
    const cfArgs = ["tunnel", "--url", localUrl, "--no-autoupdate"];
    if (process.env.CLOUDFLARED_PROTOCOL) {
      cfArgs.push("--protocol", process.env.CLOUDFLARED_PROTOCOL);
    }
    track(spawn(cf.path, cfArgs, { cwd, stdio: "inherit", env: process.env }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠ --tunnel requested but cloudflared could not be set up: ${msg}\n` +
        "  Serving loopback only. Install cloudflared manually, set CLOUDFLARED_PATH,\n" +
        `  or forward the port yourself: ssh -L ${port}:127.0.0.1:${port} <host>`
    );
  }
}
