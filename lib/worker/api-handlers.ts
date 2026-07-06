// lib/worker/api-handlers.ts
//
// Server-side handlers for the worker HTTP + SSE protocol (/api/worker/*).
// One dispatcher for the whole surface — the Next.js catch-all route
// (app/api/worker/[...path]/route.ts) is a two-line shim over this, so the
// handlers are directly unit-testable with plain Request objects.
//
// Every endpoint:
//   • authenticates the run-scoped bearer token (lib/worker/token),
//   • executes against dbTransport — the SAME implementation a direct-DB
//     worker uses, so HTTP workers and DB workers cannot drift, and
//   • logs one structured line (method, path, runId, status, duration).
//
// Endpoint table: docs/worker-http-api.md.

import { authorizeWorkerRequest } from "./token";
import { dbTransport } from "./db-transport";
import { createLogger } from "./log";
import { isTerminalStatus, SESSION_STATUSES, TASK_STATES, type SessionStatus } from "../types";
import type { ApplyStatusOpts, WireStatusGuard } from "./protocol";

const log = createLogger("worker-api");

/** How often the /control stream re-checks the cancel flag without a wake. */
const CONTROL_POLL_MS = 3_000;
const CONTROL_PING_MS = 15_000;

const GUARDS: WireStatusGuard[] = ["none", "not-terminal", "not-cancelled-closed"];
const MESSAGE_ROLES = ["user", "agent", "tool", "system"] as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function bad(message: string): never {
  throw new HttpError(400, message);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) bad("Body must be a JSON object");
    return body as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    bad("Body must be valid JSON");
  }
}

/**
 * Dispatch a worker API request. `path` is the URL segments after /api/worker
 * (e.g. ["runs", "42", "heartbeat"]).
 */
export async function handleWorkerApi(req: Request, path: string[]): Promise<Response> {
  const started = Date.now();
  const method = req.method.toUpperCase();
  const pathStr = path.join("/");
  let authRunId: number | undefined;
  try {
    const res = await route(req, method, path, (id) => (authRunId = id));
    log.info("request", {
      method,
      path: pathStr,
      runId: authRunId,
      status: res.status,
      ms: Date.now() - started,
    });
    return res;
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    (status >= 500 ? log.error : log.warn).call(log, "request failed", {
      method,
      path: pathStr,
      runId: authRunId,
      status,
      ms: Date.now() - started,
      error: message,
    });
    return json(status, { error: message });
  }
}

async function route(
  req: Request,
  method: string,
  path: string[],
  sawRun: (runId: number) => void
): Promise<Response> {
  const [root, id, ...rest] = path;

  // Authenticate first — every endpoint requires a valid worker token. The
  // token pins a run id; run-scoped endpoints additionally require the path
  // run to BE the token run.
  const auth = authorizeWorkerRequest(req, root === "runs" ? parseRunId(id) : undefined);
  if (!auth.ok) return json(auth.status, { error: auth.error });
  sawRun(auth.runId);

  if (root === "runs") {
    const runId = parseRunId(id);
    if (runId == null) bad("Bad run id");
    return routeRun(req, method, runId, rest);
  }
  if (root === "tasks" && id) return routeTask(req, method, auth.runId, decodeURIComponent(id), rest);
  if (root === "plans" && id) return routePlan(req, method, auth.runId, decodeURIComponent(id), rest);
  if (root === "personas" && id && method === "GET" && rest.length === 0) {
    const persona = await dbTransport.getPersona(decodeURIComponent(id));
    return json(200, { persona });
  }
  throw new HttpError(404, `No such worker endpoint: ${method} ${path.join("/")}`);
}

function parseRunId(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function routeRun(
  req: Request,
  method: string,
  runId: number,
  rest: string[]
): Promise<Response> {
  const sub = rest.join("/");

  if (sub === "" && method === "GET") {
    return json(200, { run: await dbTransport.getRun(runId) });
  }
  if (sub === "" && method === "PATCH") {
    const { patch } = await readBody(req);
    if (patch === null || typeof patch !== "object") bad("Missing patch object");
    await dbTransport.patchRun(runId, patch as never);
    return json(200, {});
  }
  if (sub === "messages" && method === "GET") {
    return json(200, { messages: await dbTransport.listMessages(runId) });
  }
  if (sub === "messages" && method === "POST") {
    const { role, content } = await readBody(req);
    if (!MESSAGE_ROLES.includes(role as never)) bad(`role must be one of ${MESSAGE_ROLES.join(", ")}`);
    if (!Array.isArray(content)) bad("content must be an array of content blocks");
    const message = await dbTransport.appendMessage(runId, role as never, content as never);
    return json(200, { message });
  }
  if (sub === "events" && method === "POST") {
    const { type, payload } = await readBody(req);
    if (typeof type !== "string" || !type) bad("type must be a non-empty string");
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      bad("payload must be a JSON object");
    }
    await dbTransport.appendEvent(runId, type, payload as Record<string, unknown>);
    return json(200, {});
  }
  if (sub === "events" && method === "GET") {
    const type = new URL(req.url).searchParams.get("type") ?? "";
    if (!type) bad("Missing ?type=");
    return json(200, { count: await dbTransport.countEvents(runId, type) });
  }
  if (sub === "status" && method === "POST") {
    const body = await readBody(req);
    const status = body.status as SessionStatus;
    if (!SESSION_STATUSES.includes(status)) bad(`Unknown status: ${String(body.status)}`);
    if (body.mode === "set") {
      if (isTerminalStatus(status)) {
        // setStatus's terminal branch is applyStatus(not-terminal); accept it
        // here so both transports behave identically.
        const applied = await dbTransport.applyStatus(runId, status, { guard: "not-terminal" });
        return json(200, { applied });
      }
      await dbTransport.setStatus(runId, status);
      return json(200, { applied: true });
    }
    const guard = body.guard as WireStatusGuard | undefined;
    if (guard !== undefined && !GUARDS.includes(guard)) bad(`Unknown guard: ${String(guard)}`);
    const opts: ApplyStatusOpts = {
      set: body.set as ApplyStatusOpts["set"],
      guard,
      extra: body.extra as ApplyStatusOpts["extra"],
      // Server-side retries stay 0: the HTTP client owns retry policy, and a
      // guarded replay is idempotent.
    };
    const applied = await dbTransport.applyStatus(runId, status, opts);
    return json(200, { applied });
  }
  if (sub === "heartbeat" && method === "POST") {
    return json(200, await dbTransport.heartbeat(runId));
  }
  if (sub === "cancel-ack" && method === "POST") {
    await dbTransport.ackCancel(runId);
    return json(200, {});
  }
  if (sub === "release" && method === "POST") {
    const body = await readBody(req);
    const last = body.lastProcessedUserMsgId;
    if (typeof last !== "number" || !Number.isFinite(last)) bad("lastProcessedUserMsgId must be a number");
    await dbTransport.releaseClaim(runId, {
      lastProcessedUserMsgId: last,
      idleIfNonTerminal: body.idleIfNonTerminal === true,
    });
    return json(200, {});
  }
  if (sub === "tools/call" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.tool !== "string" || !body.tool) bad("tool must be a non-empty string");
    const ctx = (body.ctx ?? {}) as Record<string, unknown>;
    if (typeof ctx.author !== "string" || !ctx.author) bad("ctx.author must be a non-empty string");
    // runId comes from the authenticated token (the path), never the body: a
    // worker can only execute tools in its own run's context.
    const result = await dbTransport.callTool(runId, body.tool, body.params, {
      author: ctx.author,
      defaultTaskId: typeof ctx.defaultTaskId === "string" ? ctx.defaultTaskId : undefined,
      defaultPlanId: typeof ctx.defaultPlanId === "string" ? ctx.defaultPlanId : undefined,
    });
    return json(200, { result });
  }
  if (sub === "inbox/claim" && method === "POST") {
    return json(200, { digest: await dbTransport.claimInboxDigest(runId) });
  }
  if (sub === "log" && method === "POST") {
    const { tail } = await readBody(req);
    if (typeof tail !== "string") bad("tail must be a string");
    await dbTransport.writeWorkerLog(runId, tail);
    return json(200, {});
  }
  if (sub === "repo" && method === "GET") {
    return json(200, { repo: await dbTransport.resolveRepo(runId) });
  }
  if (sub === "control" && method === "GET") {
    return controlStream(req, runId);
  }
  throw new HttpError(404, `No such worker endpoint: ${method} runs/${runId}/${sub}`);
}

async function routeTask(
  req: Request,
  method: string,
  tokenRunId: number,
  taskId: string,
  rest: string[]
): Promise<Response> {
  const sub = rest.join("/");
  if (sub === "" && method === "GET") {
    return json(200, { task: await dbTransport.getTask(taskId) });
  }
  // Writes are limited to the token run's OWN task — a worker token must not
  // be able to steer arbitrary board state.
  if ((sub === "transition" || sub === "notes") && method === "POST") {
    const run = await dbTransport.getRun(tokenRunId);
    if (!run || run.taskId !== taskId) {
      throw new HttpError(403, `Run ${tokenRunId} is not attached to task ${taskId}`);
    }
    const body = await readBody(req);
    if (sub === "transition") {
      if (!TASK_STATES.includes(body.state as never)) bad(`Unknown task state: ${String(body.state)}`);
      await dbTransport.transitionTask(taskId, {
        state: body.state as never,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
        bypassCriteria: body.bypassCriteria === true,
      });
      return json(200, {});
    }
    if (typeof body.author !== "string" || typeof body.body !== "string") {
      bad("notes requires { author, body } strings");
    }
    await dbTransport.addTaskNote(taskId, body.author, body.body);
    return json(200, {});
  }
  throw new HttpError(404, `No such worker endpoint: ${method} tasks/${taskId}/${sub}`);
}

async function routePlan(
  req: Request,
  method: string,
  tokenRunId: number,
  planId: string,
  rest: string[]
): Promise<Response> {
  const sub = rest.join("/");
  if (sub === "" && method === "GET") {
    return json(200, { plan: await dbTransport.getPlan(planId) });
  }
  if (sub === "tasks" && method === "GET") {
    return json(200, { tasks: await dbTransport.listTasks({ planId }) });
  }
  if (sub === "state" && method === "POST") {
    const run = await dbTransport.getRun(tokenRunId);
    if (!run || run.planId !== planId) {
      throw new HttpError(403, `Run ${tokenRunId} is not attached to plan ${planId}`);
    }
    const { state } = await readBody(req);
    if (typeof state !== "string" || !state) bad("state must be a string");
    await dbTransport.updatePlanState(planId, state);
    return json(200, {});
  }
  throw new HttpError(404, `No such worker endpoint: ${method} plans/${planId}/${sub}`);
}

// ── control SSE channel (server → worker) ───────────────────────────────────
//
// Pushes two signals to a connected worker:
//   {type:"input"}   — a new user message landed for this run (rides the
//                      Postgres 'run_input' LISTEN, same as db-mode workers)
//   {type:"cancel"}  — a cross-process cancel was requested (rides the
//                      'run_stream' LISTEN — cancel() inserts a status event —
//                      plus a low-frequency safety poll of the flag)
//
// Frames are JSON on `data:` lines; a comment ping every CONTROL_PING_MS keeps
// intermediaries from idling the connection out.

async function controlStream(req: Request, runId: number): Promise<Response> {
  const run = await dbTransport.getRun(runId);
  if (!run) throw new HttpError(404, `Run ${runId} not found`);

  const { subscribeRunStream } = await import("../run-stream-listener");
  const clog = log.child({ runId, channel: "control" });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let cancelSent = false;
      let unsubInput: (() => void) | null = null;
      let unsubStream: (() => void) | null = null;
      let poll: ReturnType<typeof setInterval> | null = null;
      let ping: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubInput?.();
        unsubStream?.();
        if (poll) clearInterval(poll);
        if (ping) clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed
        }
        clog.debug("control stream closed");
      };
      const send = (o: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const sendPing = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      };

      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) {
        cleanup();
        return;
      }

      const checkCancel = async () => {
        if (closed || cancelSent) return;
        try {
          const cur = await dbTransport.getRun(runId);
          if (cur?.cancelRequested === 1) {
            cancelSent = true;
            clog.info("pushing cancel to worker");
            send({ type: "cancel" });
          }
        } catch {
          // transient read failure — the poll retries
        }
      };

      try {
        unsubInput = await dbTransport.subscribeInput(runId, () => send({ type: "input" }));
        unsubStream = await subscribeRunStream(runId, () => void checkCancel());
      } catch (err) {
        clog.warn("LISTEN unavailable; relying on poll", { error: err as Error });
      }
      clog.info("control stream opened");

      await checkCancel();
      poll = setInterval(() => void checkCancel(), CONTROL_POLL_MS);
      ping = setInterval(sendPing, CONTROL_PING_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
