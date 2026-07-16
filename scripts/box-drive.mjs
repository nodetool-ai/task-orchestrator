// scripts/box-drive.mjs
//
// One-shot control-plane driver for a task-orchestrator worker running inside an
// ascii.dev Box and exposed via `host` (see scripts/box-setup.sh). It plays the
// control plane for a single goal run: dials the Box's WSS URL, runs the channel
// handshake, pushes one run.start, streams the real Claude agent turn, and
// commits the terminal outcome. Proves a real agent turn over the Box worker
// channel end-to-end.
//
// Run from the repo root so the `ws` dependency resolves:
//   node scripts/box-drive.mjs <hostUrl> <credential> <instanceId> <runId> "<goal>"
//
// hostUrl:    the `https://<sub>-8787.on.ascii.dev?_token=…` printed by `host`
// credential: the TASK_ORCH_WORKER_CHANNEL_CREDENTIAL the Box worker was started with
// instanceId: the TASK_ORCH_WORKER_INSTANCE_ID the Box worker was started with
// runId:      the run id the Box worker was started with
// goal:       the free-form goal for the single-turn run
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const [, , hostUrl, credential, instanceId, runIdArg, goal] = process.argv;
if (!hostUrl || !credential || !instanceId || !runIdArg || !goal) {
  console.error('usage: node scripts/box-drive.mjs <hostUrl> <credential> <instanceId> <runId> "<goal>"');
  process.exit(2);
}
const RUN_ID = Number(runIdArg);
const SUBPROTOCOL = "task-orchestrator.worker.v1";
const MODEL = process.env.BOX_DRIVE_MODEL ?? "claude-haiku-4-5-20251001";

// The `host` proxy gates a private port with a `_port_auth` cookie (set via a
// 302 when ?_token=… is visited). Dial WITHOUT the query — carry the token as
// the cookie instead — plus the worker's own bearer credential.
const u = new URL(hostUrl);
const token = u.searchParams.get("_token");
const wsUrl = `wss://${u.host}/worker/channel`;

// A freshly (re)launched worker takes a moment to bind its listener, and the
// host proxy returns 502 until the tunnel is warm. Dial with a bounded boot
// backoff, mirroring the control plane's connectWithBootBackoff.
async function dial() {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    const sock = new WebSocket(wsUrl, [SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${credential}`, ...(token ? { Cookie: `_port_auth=${token}` } : {}) },
      handshakeTimeout: 15_000,
    });
    const ok = await new Promise((resolve) => {
      sock.once("upgrade", (r) => console.log(`[upgrade] ${r.statusCode} proto=${r.headers["sec-websocket-protocol"]}`));
      sock.once("open", () => resolve(true));
      sock.once("unexpected-response", (_q, r) => { console.log(`[dial] ${r.statusCode}, retrying…`); resolve(false); });
      sock.once("error", (e) => { console.log(`[dial] ${e.message}, retrying…`); resolve(false); });
    });
    if (ok) return sock;
    try { sock.terminate(); } catch {}
    if (Date.now() > deadline) { console.error("[dial] gave up after boot backoff"); process.exit(1); }
    await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 5_000)));
  }
}

const ws = await dial();
console.log(`[open] negotiated=${ws.protocol}`);

let controlSeq = 0;
const send = (f) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));
const cmd = (type, payload, replyTo) =>
  send({ v: 1, type, id: randomUUID(), runId: RUN_ID, instanceId, controllerEpoch: 1, seq: ++controlSeq, sentAt: new Date().toISOString(), ...(replyTo ? { replyTo } : {}), payload });
const ack = (seq) => send({ v: 1, type: "channel.ack", id: randomUUID(), runId: RUN_ID, instanceId, controllerEpoch: 1, seq: 0, sentAt: new Date().toISOString(), payload: { throughSeq: seq } });

const runStart = {
  mode: "start",
  run: { id: RUN_ID, status: "running", goal, model: MODEL, backend: "claude", worktreePath: "/home/user/task-orchestrator", taskId: null, planId: null, completedAt: null },
  task: null, plan: null,
  persona: { id: "box-e2e", name: "box-e2e" },
  repository: { id: "box-e2e", localPath: "/home/user/task-orchestrator", remote: null },
  transcript: [], inboxDigest: null, memoryContext: "", pendingInput: [],
  policy: { allowedTools: [], maxTurns: null, deadline: null },
  kickoffPrompt: goal,
};

const text = (blocks) => (blocks || []).filter((b) => b?.type === "text").map((b) => b.text).join("").trim();
const done = (code) => { try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => { console.error("TIMEOUT"); done(1); }, 180_000);

ws.on("error", (e) => { console.error(`[error] ${e.message}`); done(1); });
ws.on("close", (c, r) => console.log(`[close] ${c} ${r}`));

ws.on("message", (data) => {
  let f; try { f = JSON.parse(data.toString("utf8")); } catch { return; }
  if (f.type === "channel.hello") {
    console.log("[hello] worker up; sending accept + run.start");
    send({ v: 1, type: "channel.accept", seq: 0, payload: { protocol: 1, controllerEpoch: 1, leaseId: "box-e2e", lastAcceptedWorkerSeq: 0, heartbeatMs: 10_000, disconnectGraceMs: 60_000, maxInFlightBytes: 8_388_608 } });
    cmd("run.start", runStart);
    return;
  }
  if (f.type === "channel.ack" || f.type === "channel.nack") return;
  switch (f.type) {
    case "run.phase": console.log(`[phase] ${f.payload.phase}`); break;
    case "transcript.append": {
      const m = f.payload.message; const t = text(m.content);
      if (m.role === "agent" && t) console.log(`\nAGENT> ${t}\n`);
      else if (m.role === "tool") console.log(`  [tool result] ${text(m.content).slice(0, 200)}`);
      else if (Array.isArray(m.content)) for (const b of m.content) if (b?.type === "tool_use") console.log(`  [tool_use] ${b.name} ${JSON.stringify(b.input).slice(0, 160)}`);
      break;
    }
    case "run.finished":
      console.log(`\n✔ RUN FINISHED: ${typeof f.payload.result === "string" ? f.payload.result : JSON.stringify(f.payload.result)}`);
      if (f.payload.usage) console.log(`  usage: ${JSON.stringify(f.payload.usage)}`);
      cmd("run.commit", { status: "completed", result: f.payload.result, usage: f.payload.usage }, f.id);
      ack(f.seq); setTimeout(() => done(0), 1500); return;
    case "run.failed":
      console.error(`\n✘ RUN FAILED: ${f.payload.error}`);
      cmd("run.commit", { status: "failed", error: f.payload.error }, f.id);
      ack(f.seq); setTimeout(() => done(1), 1500); return;
    case "run.checkpoint": console.log(`[checkpoint] sdkSessionId=${f.payload.sdkSessionId ?? "none"}`); break;
    case "worker.log": for (const e of f.payload.entries || []) console.log(`  [worker.log:${e.level || "info"}] ${e.message}`); break;
  }
  if (typeof f.seq === "number" && f.seq > 0) ack(f.seq);
});
