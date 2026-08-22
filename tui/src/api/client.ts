// REST + SSE client for the orchestrator server. The TUI talks to the server
// over HTTP only (PRD §4 item 10): nothing here imports from the server's lib/.

import { sseFrames } from "./sse.js";
import type {
  GlobalInboxRow,
  MessageRow,
  PlanSummary,
  RunDetail,
  RunIndexRow,
  RunInbox,
  StreamCursor,
  TaskSummary,
} from "./types.js";

export interface ClientConfig {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  /** Backoff knobs, injectable so tests don't sleep for real. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown on 401. Carries a one-line remedy in `.hint`. */
export class UnauthorizedError extends ApiError {
  readonly hint: string;
  constructor(body: unknown, message = "Unauthorized") {
    super(401, message, body);
    this.name = "UnauthorizedError";
    this.hint = AUTH_HINT;
  }
}

const AUTH_HINT = "npm run task -- user link …, or set ORCH_TOKEN from the token page";

export interface Subscription {
  close(): void;
}

export interface OverviewHandlers {
  onRows(rows: RunIndexRow[]): void;
  /** Server said `_eos` (unauthenticated): stop reconnecting, caller should poll. */
  onEnd?(): void;
  onError?(err: unknown): void;
  /** Fired on every reconnect attempt, for a status line. */
  onReconnect?(attempt: number, delayMs: number): void;
}

export interface RunEventHandlers {
  onMessage(message: MessageRow): void;
  /** Any agent event frame: `{ type, ...payload }`, e.g. type "status". */
  onEvent(frame: Record<string, unknown> & { type: string }): void;
  onCursor?(cursor: StreamCursor): void;
  onEnd?(): void;
  onError?(err: unknown): void;
  onReconnect?(attempt: number, delayMs: number): void;
}

export interface OrchClient {
  overview(): Promise<RunIndexRow[]>;
  listRuns(): Promise<RunIndexRow[]>;
  run(id: number): Promise<RunDetail>;
  runInbox(id: number): Promise<RunInbox>;
  inbox(): Promise<GlobalInboxRow[]>;
  tasks(): Promise<TaskSummary[]>;
  plans(): Promise<PlanSummary[]>;
  overviewEvents(h: OverviewHandlers): Subscription;
  runEvents(id: number, cursor: StreamCursor, h: RunEventHandlers): Subscription;
}

const DEFAULT_URL = "http://localhost:3000";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Server errors are JSON `{error}` on the REST routes but plain text on the
 * pre-stream path of /api/runs/:id/events, so sniff rather than assume. */
async function errorFor(res: Response): Promise<ApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* body already consumed or socket gone */
  }
  let body: unknown = text;
  let message = text.trim();
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      body = parsed;
      const err = (parsed as { error?: unknown }).error;
      if (typeof err === "string") message = err;
    } catch {
      /* keep the raw text */
    }
  }
  if (!message) message = `HTTP ${res.status}`;
  if (res.status === 401) return new UnauthorizedError(body, message);
  return new ApiError(res.status, message, body);
}

export function createClient(cfg: Partial<ClientConfig> = {}): OrchClient {
  const base = (cfg.url ?? process.env.ORCH_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const token = cfg.token ?? process.env.ORCH_TOKEN;
  const doFetch = cfg.fetch ?? fetch;
  const minBackoffMs = cfg.minBackoffMs ?? 1000;
  const maxBackoffMs = cfg.maxBackoffMs ?? 30000;
  const sleep = cfg.sleep ?? defaultSleep;

  // Bearer support on these routes lands with T-tui-11; today the server
  // authenticates with a NextAuth session cookie and ignores the header.
  const authHeaders = (accept: string): Record<string, string> => {
    const h: Record<string, string> = { accept };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(`${base}${path}`, { headers: authHeaders("application/json") });
    if (!res.ok) throw await errorFor(res);
    return (await res.json()) as T;
  }

  /**
   * One reconnecting SSE subscription. `urlFor` is re-evaluated per attempt so
   * a run stream resumes from the newest cursor; `onFrame` returns true to end
   * the subscription (the server's `_eos`).
   */
  function subscribe(
    urlFor: () => string,
    onFrame: (frame: Record<string, unknown> & { type: string }) => boolean,
    h: { onEnd?(): void; onError?(err: unknown): void; onReconnect?(a: number, d: number): void },
  ): Subscription {
    let closed = false;
    let controller: AbortController | null = null;

    const loop = async () => {
      let attempt = 0;
      while (!closed) {
        controller = new AbortController();
        let delivered = false;
        let ended = false;
        try {
          const res = await doFetch(urlFor(), {
            headers: authHeaders("text/event-stream"),
            signal: controller.signal,
          });
          if (!res.ok) throw await errorFor(res);
          if (!res.body) throw new ApiError(res.status, "Stream had no body", null);
          for await (const data of sseFrames(res.body as ReadableStream<Uint8Array>)) {
            if (closed) break;
            delivered = true;
            let frame: unknown;
            try {
              frame = JSON.parse(data);
            } catch {
              continue; // a malformed frame must not kill the stream
            }
            if (!frame || typeof frame !== "object") continue;
            const typed = frame as Record<string, unknown> & { type: string };
            if (typeof typed.type !== "string") continue;
            if (onFrame(typed)) {
              ended = true;
              break;
            }
          }
        } catch (err) {
          if (closed) return;
          // Retrying a 401 cannot succeed; surface it and stop.
          if (err instanceof UnauthorizedError) {
            h.onError?.(err);
            return;
          }
          h.onError?.(err);
        } finally {
          controller?.abort();
        }
        if (closed) return;
        if (ended) {
          h.onEnd?.();
          return;
        }
        if (delivered) attempt = 0; // a productive connection resets backoff
        attempt++;
        const delayMs = Math.min(maxBackoffMs, minBackoffMs * 2 ** (attempt - 1));
        h.onReconnect?.(attempt, delayMs);
        await sleep(delayMs);
      }
    };

    void loop();

    return {
      close() {
        if (closed) return;
        closed = true;
        controller?.abort();
      },
    };
  }

  return {
    overview: () => getJson<{ rows: RunIndexRow[] }>("/api/runs/overview").then((r) => r.rows ?? []),

    // There is no GET /api/runs handler (POST only — a GET gets Next's 405), so
    // the run list is /api/runs/overview, which already returns every run
    // unfiltered, newest first.
    listRuns: () =>
      getJson<{ rows: RunIndexRow[] }>("/api/runs/overview").then((r) => r.rows ?? []),

    run: (id: number) => getJson<RunDetail>(`/api/runs/${id}`),

    runInbox: (id: number) => getJson<RunInbox>(`/api/runs/${id}/inbox`),

    inbox: () =>
      getJson<{ items: GlobalInboxRow[] }>("/api/inbox?audience=owner").then((r) => r.items ?? []),

    // /api/tasks and /api/plans answer with bare arrays of the full rows; the
    // cockpit only needs the palette fields.
    tasks: async () => {
      const rows = await getJson<Array<TaskSummary & Record<string, unknown>>>("/api/tasks");
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state,
        planId: t.planId,
        prUrl: t.prUrl ?? null,
      }));
    },

    plans: async () => {
      const rows = await getJson<Array<PlanSummary & Record<string, unknown>>>("/api/plans");
      return rows.map((p) => ({ id: p.id, title: p.title, state: p.state }));
    },

    overviewEvents(h: OverviewHandlers): Subscription {
      // The overview stream is cursorless: every connect replays a full `rows`
      // snapshot. Byte-identical repeats are suppressed server-side, so a long
      // ping-only stretch is normal and is not a dropped connection.
      return subscribe(
        () => `${base}/api/runs/overview/events`,
        (frame) => {
          if (frame.type === "_eos") return true;
          if (frame.type === "rows") h.onRows((frame.rows as RunIndexRow[]) ?? []);
          return false;
        },
        h,
      );
    },

    runEvents(id: number, cursor: StreamCursor, h: RunEventHandlers): Subscription {
      let last: StreamCursor = { ...cursor };
      return subscribe(
        () => `${base}/api/runs/${id}/events?msgCursor=${last.msgId}&evtCursor=${last.evtId}`,
        (frame) => {
          switch (frame.type) {
            case "_eos":
              return true;
            case "_cursor": {
              const c = frame.cursor as StreamCursor | undefined;
              if (c && typeof c.msgId === "number" && typeof c.evtId === "number") {
                last = { msgId: c.msgId, evtId: c.evtId };
                h.onCursor?.(last);
              }
              return false;
            }
            case "message":
              h.onMessage(frame.message as MessageRow);
              return false;
            default:
              h.onEvent(frame);
              return false;
          }
        },
        h,
      );
    },
  };
}
