// lib/worker/http-transport.ts
//
// The HTTP + SSE implementation of RunTransport: a typed client for the
// /api/worker/* endpoints (see docs/worker-http-api.md). Selected inside a
// worker process when TASK_ORCH_WORKER_API_URL + TASK_ORCH_WORKER_TOKEN are
// set; the worker then needs NO database access.
//
// Debuggability: every request is logged at debug (method, path, status,
// duration), every retry and failure at warn/error — set
// TASK_ORCH_LOG_LEVEL=debug in a worker's env to watch the full protocol
// conversation in `docker logs` / `fly logs`.
//
// Retry policy: GETs and idempotent POSTs (heartbeat, release, log, status —
// status is CAS-guarded server-side, so a replay after an ambiguous failure is
// a no-op) retry on network errors and 5xx with short backoff. Message/event
// appends do NOT auto-retry: a replay would duplicate a row, and the callers
// that need exit-path durability (applyStatus retries) opt in explicitly.

import { createLogger } from "./log";
import { reviveDates } from "./protocol";
import type {
  ApplyStatusOpts,
  HeartbeatResult,
  RunPatch,
  RunTransport,
  TaskTransitionInput,
} from "./protocol";

const log = createLogger("worker-transport-http");

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = [500, 1000, 2000];
/** SSE reconnect backoff (resets after a healthy connection). */
const SSE_RECONNECT_MS = [1000, 2000, 5000, 10_000];

export class WorkerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string
  ) {
    super(message);
    this.name = "WorkerApiError";
  }
}

function isRetriableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 429;
}

export interface HttpTransportOpts {
  baseUrl: string;
  token: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export function createHttpTransport(opts: HttpTransportOpts): RunTransport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  // Cancel push latch: the /control SSE channel can deliver a cancel signal
  // between heartbeats; the next heartbeat() answer folds it in so the turn
  // aborts without waiting for the server-side flag read to catch up.
  const cancelLatch = new Set<number>();

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    o: { retries?: number } = {}
  ): Promise<T> {
    const retries = o.retries ?? (method === "GET" ? 2 : 0);
    const url = `${base}/api/worker/${path}`;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      try {
        const res = await doFetch(url, {
          method,
          headers: {
            authorization: `Bearer ${opts.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const ms = Date.now() - started;
        if (!res.ok) {
          let detail = "";
          try {
            detail = ((await res.json()) as { error?: string }).error ?? "";
          } catch {
            // non-JSON error body
          }
          const err = new WorkerApiError(
            `${method} /api/worker/${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
            res.status,
            path
          );
          if (isRetriableStatus(res.status) && attempt < retries) {
            log.warn("retriable API error", { method, path, status: res.status, attempt, ms });
            await backoff(attempt);
            continue;
          }
          log.error("API error", { method, path, status: res.status, detail, ms });
          throw err;
        }
        log.debug("api", { method, path, status: res.status, ms });
        return reviveDates((await res.json()) as T);
      } catch (err) {
        if (err instanceof WorkerApiError) throw err;
        // Network-level failure (ECONNREFUSED, timeout, reset).
        if (attempt < retries) {
          log.warn("network error, retrying", { method, path, attempt, error: err as Error });
          await backoff(attempt);
          continue;
        }
        log.error("network error", { method, path, error: err as Error });
        throw err;
      }
    }
  }

  function backoff(attempt: number): Promise<void> {
    const ms = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
    return new Promise((r) => setTimeout(r, ms));
  }

  // ── /control SSE channel ──────────────────────────────────────────────────
  // One connection per subscribed run: `input` events wake the chat loop,
  // `cancel` events arm the latch. Auto-reconnects until unsubscribed.

  function openControlStream(
    runId: number,
    handlers: { onInput: () => void }
  ): () => void {
    const abort = new AbortController();
    let stopped = false;

    const run = async () => {
      let failures = 0;
      while (!stopped) {
        try {
          const res = await doFetch(`${base}/api/worker/runs/${runId}/control`, {
            headers: { authorization: `Bearer ${opts.token}`, accept: "text/event-stream" },
            signal: abort.signal,
          });
          if (!res.ok || !res.body) {
            throw new WorkerApiError(`control stream → ${res.status}`, res.status, `runs/${runId}/control`);
          }
          log.info("control stream connected", { runId });
          failures = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const data = frame
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .join("\n");
              if (!data) continue; // comment/ping frame
              try {
                const ev = JSON.parse(data) as { type?: string };
                if (ev.type === "input") handlers.onInput();
                else if (ev.type === "cancel") {
                  log.info("cancel received on control stream", { runId });
                  cancelLatch.add(runId);
                }
              } catch {
                log.warn("unparseable control frame", { runId, data });
              }
            }
          }
          // Server closed (deploy, idle timeout) — reconnect.
          log.debug("control stream ended; reconnecting", { runId });
        } catch (err) {
          if (stopped || abort.signal.aborted) return;
          const ms = SSE_RECONNECT_MS[Math.min(failures, SSE_RECONNECT_MS.length - 1)];
          failures++;
          log.warn("control stream error; reconnecting", { runId, inMs: ms, error: err as Error });
          await new Promise((r) => setTimeout(r, ms));
        }
      }
    };
    void run();

    return () => {
      stopped = true;
      abort.abort();
    };
  }

  return {
    kind: "http",

    async getRun(runId) {
      const { run } = await request<{ run: unknown }>("GET", `runs/${runId}`);
      return (run as never) ?? null;
    },

    async listMessages(runId) {
      const { messages } = await request<{ messages: never[] }>("GET", `runs/${runId}/messages`);
      return messages;
    },

    async appendMessage(runId, role, content) {
      const { message } = await request<{ message: never }>("POST", `runs/${runId}/messages`, {
        role,
        content,
      });
      return message;
    },

    async appendEvent(runId, type, payload) {
      await request("POST", `runs/${runId}/events`, { type, payload });
    },

    async countEvents(runId, type) {
      const { count } = await request<{ count: number }>(
        "GET",
        `runs/${runId}/events?type=${encodeURIComponent(type)}`
      );
      return count;
    },

    async applyStatus(runId, status, o: ApplyStatusOpts = {}) {
      // The server-side write is CAS-guarded, so retrying an ambiguous failure
      // is safe (a replay after a landed write matches 0 rows → applied:false,
      // which callers already treat as "someone finalized").
      const { applied } = await request<{ applied: boolean }>(
        "POST",
        `runs/${runId}/status`,
        { mode: "cas", status, set: o.set, guard: o.guard, extra: o.extra },
        { retries: o.retries ?? 0 }
      );
      return applied;
    },

    async setStatus(runId, status) {
      await request("POST", `runs/${runId}/status`, { mode: "set", status }, { retries: 1 });
    },

    async patchRun(runId, patch: RunPatch) {
      await request("PATCH", `runs/${runId}`, { patch }, { retries: 1 });
    },

    async heartbeat(runId): Promise<HeartbeatResult> {
      try {
        const r = await request<HeartbeatResult>("POST", `runs/${runId}/heartbeat`, {}, { retries: 1 });
        return { cancelRequested: r.cancelRequested || cancelLatch.has(runId) };
      } catch (err) {
        // A missed beat must never crash a turn; the lease has minutes of slack.
        log.warn("heartbeat failed", { runId, error: err as Error });
        return { cancelRequested: cancelLatch.has(runId) };
      }
    },

    async ackCancel(runId) {
      cancelLatch.delete(runId);
      await request("POST", `runs/${runId}/cancel-ack`, {}, { retries: 1 });
    },

    async releaseClaim(runId, { lastProcessedUserMsgId, idleIfNonTerminal }) {
      await request(
        "POST",
        `runs/${runId}/release`,
        { lastProcessedUserMsgId, idleIfNonTerminal: idleIfNonTerminal === true },
        { retries: 2 } // exit path: the claim MUST be released or the run wedges
      );
    },

    async subscribeInput(runId, onInput) {
      return openControlStream(runId, { onInput });
    },

    async claimInboxDigest(runId) {
      const { digest } = await request<{ digest: string | null }>(
        "POST",
        `runs/${runId}/inbox/claim`
      );
      return digest;
    },

    async writeWorkerLog(runId, tail) {
      await request("POST", `runs/${runId}/log`, { tail }, { retries: 1 });
    },

    async getTask(taskId) {
      const { task } = await request<{ task: never }>("GET", `tasks/${encodeURIComponent(taskId)}`);
      return task ?? null;
    },

    async transitionTask(taskId, input: TaskTransitionInput) {
      await request("POST", `tasks/${encodeURIComponent(taskId)}/transition`, input);
    },

    async addTaskNote(taskId, author, body) {
      await request("POST", `tasks/${encodeURIComponent(taskId)}/notes`, { author, body });
    },

    async getPlan(planId) {
      const { plan } = await request<{ plan: never }>("GET", `plans/${encodeURIComponent(planId)}`);
      return plan ?? null;
    },

    async listTasks(filter) {
      const { tasks } = await request<{ tasks: never[] }>(
        "GET",
        `plans/${encodeURIComponent(filter.planId)}/tasks`
      );
      return tasks;
    },

    async updatePlanState(planId, state) {
      await request("POST", `plans/${encodeURIComponent(planId)}/state`, { state });
    },

    async getPersona(personaId) {
      const { persona } = await request<{ persona: never }>(
        "GET",
        `personas/${encodeURIComponent(personaId)}`
      );
      return persona ?? null;
    },

    async resolveRepo(runId) {
      const { repo } = await request<{ repo: never }>("GET", `runs/${runId}/repo`);
      return repo ?? null;
    },

    async callTool(runId, tool, params, ctx) {
      if (runId == null) {
        return {
          content: [{ type: "text", text: "Tool calls need a run context in HTTP worker mode." }],
          isError: true,
        };
      }
      const { result } = await request<{ result: never }>("POST", `runs/${runId}/tools/call`, {
        tool,
        params,
        ctx,
      });
      return result;
    },
  };
}
