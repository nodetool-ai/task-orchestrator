import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiError,
  UnauthorizedError,
  createClient,
  type Subscription,
} from "../src/api/client.js";
import type { RunIndexRow, StreamCursor } from "../src/api/types.js";

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Fake {
  url: string;
  /** Every request path the server has seen, in order. */
  paths: string[];
  auth: Array<string | undefined>;
  close(): Promise<void>;
}

const servers: http.Server[] = [];

async function fakeServer(handler: Handler): Promise<Fake> {
  const paths: string[] = [];
  const auth: Array<string | undefined> = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    auth.push(req.headers.authorization);
    handler(req, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    auth,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await tick(5);
  }
}

const row = (id: number): RunIndexRow =>
  ({
    id,
    goal: "g",
    status: "running",
    origin: "task",
    title: `run ${id}`,
    taskId: null,
    taskTitle: null,
    planId: null,
    planTitle: null,
    repoId: null,
    repoName: null,
    parentRunId: null,
    prUrl: null,
    model: null,
    budgetMaxUsd: null,
    budgetMaxTurns: null,
    totalCostUsd: null,
    error: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    parkReason: null,
    pendingReason: null,
    pendingEvents: 0,
    personaId: null,
    personaName: null,
  }) satisfies RunIndexRow;

const subs: Subscription[] = [];
function track(s: Subscription): Subscription {
  subs.push(s);
  return s;
}

afterEach(async () => {
  for (const s of subs.splice(0)) s.close();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections();
          s.close(() => r(null));
        }),
    ),
  );
});

describe("REST surface", () => {
  it("parses every typed endpoint", async () => {
    const fake = await fakeServer((req, res) => {
      const path = req.url ?? "";
      if (path === "/api/runs/overview") return json(res, 200, { rows: [row(1), row(2)] });
      if (path === "/api/runs/7")
        return json(res, 200, { id: 7, goal: "g", status: "idle", messages: [], live: true });
      if (path === "/api/runs/7/inbox")
        return json(res, 200, { events: [{ id: 1, type: "question" }], timers: [] });
      if (path === "/api/inbox?audience=owner")
        return json(res, 200, { items: [{ id: "e1", runId: 7, kind: "question" }] });
      if (path === "/api/tasks")
        return json(res, 200, [
          { id: "T-1", title: "t", state: "open", planId: "P-1", prUrl: null, body: "big" },
        ]);
      if (path === "/api/plans")
        return json(res, 200, [{ id: "P-1", title: "p", state: "active", body: "big" }]);
      if (path === "/api/providers")
        return json(res, 200, {
          providers: [{ id: "anthropic", models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] }],
          backends: [
            { id: "claude", providers: [{ id: "anthropic", models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] }] },
          ],
          defaultBackend: "claude",
        });
      return json(res, 404, { error: "Not found" });
    });
    const c = createClient({ url: fake.url });

    expect((await c.overview()).map((r) => r.id)).toEqual([1, 2]);
    expect((await c.listRuns()).map((r) => r.id)).toEqual([1, 2]);
    expect((await c.run(7)).live).toBe(true);
    expect((await c.runInbox(7)).events).toHaveLength(1);
    expect((await c.inbox())[0]!.id).toBe("e1");
    // Full rows are mapped down to the summary shape.
    expect(await c.tasks()).toEqual([
      { id: "T-1", title: "t", state: "open", planId: "P-1", prUrl: null },
    ]);
    expect(await c.plans()).toEqual([{ id: "P-1", title: "p", state: "active" }]);
    expect((await c.providers()).backends[0]!.providers[0]!.models[0]!.id).toBe("claude-haiku-4-5");
    expect(fake.paths).toContain("/api/providers");
  });

  it("surfaces JSON errors as ApiError", async () => {
    const fake = await fakeServer((_req, res) => json(res, 404, { error: "Not found" }));
    const c = createClient({ url: fake.url });
    await expect(c.run(9)).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "Not found",
    });
    await expect(c.run(9)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("auth", () => {
  it("sends Bearer when a token is configured and nothing when it is not", async () => {
    const fake = await fakeServer((_req, res) => json(res, 200, { rows: [] }));
    await createClient({ url: fake.url, token: "tok-123" }).overview();
    await createClient({ url: fake.url }).overview();
    expect(fake.auth[0]).toBe("Bearer tok-123");
    expect(fake.auth[1]).toBeUndefined();
  });

  it("throws UnauthorizedError with a hint for a JSON 401", async () => {
    const fake = await fakeServer((_req, res) => json(res, 401, { error: "Unauthorized" }));
    const c = createClient({ url: fake.url });
    const err = await c.overview().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    const u = err as UnauthorizedError;
    expect(u.status).toBe(401);
    expect(u.body).toEqual({ error: "Unauthorized" });
    expect(u.hint).toContain("ORCH_TOKEN");
  });

  // The hint is the only thing a user sees when the token is wrong, so it has
  // to name the real remediation: an API token from the server's settings page
  // (the same tot_ tokens /api/mcp takes), not some other flow.
  it("the 401 hint points at this server's token page and the login-link verb", async () => {
    const fake = await fakeServer((_req, res) => json(res, 401, { error: "Unauthorized" }));
    const err = await createClient({ url: `${fake.url}/`, token: "tot_bogus" })
      .inbox()
      .catch((e: unknown) => e);
    const hint = (err as UnauthorizedError).hint;
    expect(hint).toContain("ORCH_TOKEN");
    expect(hint).toContain(`${fake.url}/settings?tab=tokens`);
    expect(hint).toContain("npm run task -- user link");
    expect(hint.split("\n")).toHaveLength(1);
  });

  it("throws UnauthorizedError for an empty 401 body", async () => {
    const fake = await fakeServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const err = await createClient({ url: fake.url })
      .run(1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as UnauthorizedError).message).toBe("HTTP 401");
    expect((err as UnauthorizedError).hint).toContain("user link");
  });
});

describe("run events stream", () => {
  const instant = { minBackoffMs: 1000, maxBackoffMs: 30000, sleep: async () => {} };

  it("resumes from the last cursor after a drop", async () => {
    let conn = 0;
    const fake = await fakeServer((_req, res) => {
      conn++;
      sseHead(res);
      if (conn === 1) {
        res.write('data: {"type":"message","message":{"id":11}}\n\n');
        res.write('data: {"type":"_cursor","cursor":{"msgId":11,"evtId":4}}\n\n');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.write('data: {"type":"_eos"}\n\n');
    });

    const messages: number[] = [];
    const cursors: StreamCursor[] = [];
    let ended = false;
    track(
      createClient({ url: fake.url, ...instant }).runEvents(
        7,
        { msgId: 0, evtId: 0 },
        {
          onMessage: (m) => messages.push(m.id),
          onEvent: () => {},
          onCursor: (c) => cursors.push(c),
          onEnd: () => {
            ended = true;
          },
          onError: () => {},
        },
      ),
    );

    await waitFor(() => ended);
    expect(messages).toEqual([11]);
    expect(cursors).toEqual([{ msgId: 11, evtId: 4 }]);
    expect(fake.paths[0]).toBe("/api/runs/7/events?msgCursor=0&evtCursor=0");
    expect(fake.paths[1]).toBe("/api/runs/7/events?msgCursor=11&evtCursor=4");
  });

  it("stops reconnecting on _eos", async () => {
    const fake = await fakeServer((_req, res) => {
      sseHead(res);
      res.write('data: {"type":"_eos"}\n\n');
    });
    let ended = false;
    track(
      createClient({ url: fake.url, ...instant }).runEvents(
        1,
        { msgId: 0, evtId: 0 },
        { onMessage: () => {}, onEvent: () => {}, onEnd: () => (ended = true) },
      ),
    );
    await waitFor(() => ended);
    await tick(60);
    expect(fake.paths).toHaveLength(1);
  });

  it("backs off 1s → 30s and resets after a delivered frame", async () => {
    let conn = 0;
    const fake = await fakeServer((_req, res) => {
      conn++;
      sseHead(res);
      // The 8th connection delivers a frame before dropping; every other one
      // drops without delivering anything.
      if (conn === 8) res.write('data: {"type":"status","status":"running"}\n\n');
      setTimeout(() => res.destroy(), 5);
    });

    const delays: number[] = [];
    let events = 0;
    const sub = track(
      createClient({
        url: fake.url,
        minBackoffMs: 1000,
        maxBackoffMs: 30000,
        sleep: async () => {},
      }).runEvents(
        3,
        { msgId: 0, evtId: 0 },
        {
          onMessage: () => {},
          onEvent: () => {
            events++;
          },
          onError: () => {},
          onReconnect: (_a, d) => delays.push(d),
        },
      ),
    );

    await waitFor(() => delays.length >= 9);
    sub.close();
    expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(events).toBe(1);
    expect(delays[7]).toBe(1000); // the 8th connection delivered a frame: reset
  });

  it("ignores keepalive comments and reassembles split and multi-line frames", async () => {
    const fake = await fakeServer((_req, res) => {
      sseHead(res);
      res.write(": ping\n\n");
      res.write('data: {"type":"sta');
      setTimeout(() => {
        res.write('tus","status":"running"}\n\n');
        // A single frame spread over two data: lines is joined with a newline.
        res.write('data: {"type":"note",\ndata: "text":"hi"}\n\n');
        res.write(": ping\n\n");
        res.write('data: {"type":"_eos"}\n\n');
      }, 15);
    });

    const seen: Array<Record<string, unknown>> = [];
    let ended = false;
    track(
      createClient({ url: fake.url, ...instant }).runEvents(
        5,
        { msgId: 0, evtId: 0 },
        {
          onMessage: () => {},
          onEvent: (f) => seen.push(f),
          onEnd: () => (ended = true),
        },
      ),
    );
    await waitFor(() => ended);
    expect(seen).toEqual([
      { type: "status", status: "running" },
      { type: "note", text: "hi" },
    ]);
  });

  it("close() aborts the in-flight request and schedules nothing further", async () => {
    let aborted = 0;
    const fake = await fakeServer((req, res) => {
      req.on("aborted", () => aborted++);
      res.on("close", () => {});
      sseHead(res);
      res.write(": ping\n\n"); // held open, never ends on its own
    });
    const sub = createClient({ url: fake.url, ...instant }).runEvents(
      2,
      { msgId: 0, evtId: 0 },
      { onMessage: () => {}, onEvent: () => {}, onError: () => {} },
    );
    await waitFor(() => fake.paths.length === 1);
    sub.close();
    await waitFor(() => aborted === 1);
    await tick(80);
    expect(fake.paths).toHaveLength(1);
  });

  it("reports a plain-text pre-stream error", async () => {
    const fake = await fakeServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    });
    const errors: unknown[] = [];
    const sub = track(
      createClient({ url: fake.url, ...instant }).runEvents(
        99,
        { msgId: 0, evtId: 0 },
        {
          onMessage: () => {},
          onEvent: () => {},
          onError: (e) => errors.push(e),
        },
      ),
    );
    await waitFor(() => errors.length > 0);
    sub.close();
    expect(errors[0]).toBeInstanceOf(ApiError);
    expect(errors[0]).toMatchObject({ status: 404, message: "Not found", body: "Not found" });
  });
});

describe("overview stream", () => {
  const instant = { minBackoffMs: 1000, maxBackoffMs: 30000, sleep: async () => {} };

  it("delivers row snapshots and reconnects without a cursor", async () => {
    let conn = 0;
    const fake = await fakeServer((_req, res) => {
      conn++;
      sseHead(res);
      res.write(`data: {"type":"rows","rows":[${JSON.stringify(row(conn))}]}\n\n`);
      if (conn === 1) setTimeout(() => res.destroy(), 10);
    });
    const snapshots: number[][] = [];
    track(
      createClient({ url: fake.url, ...instant }).overviewEvents({
        onRows: (rows) => snapshots.push(rows.map((r) => r.id)),
        onError: () => {},
      }),
    );
    await waitFor(() => snapshots.length >= 2);
    expect(snapshots.slice(0, 2)).toEqual([[1], [2]]);
    expect(fake.paths.slice(0, 2)).toEqual([
      "/api/runs/overview/events",
      "/api/runs/overview/events",
    ]);
  });

  it("stops on _eos so the caller can fall back to polling", async () => {
    const fake = await fakeServer((_req, res) => {
      sseHead(res);
      res.write('data: {"type":"_eos"}\n\n');
    });
    let ended = false;
    track(
      createClient({ url: fake.url, ...instant }).overviewEvents({
        onRows: () => {},
        onEnd: () => (ended = true),
      }),
    );
    await waitFor(() => ended);
    await tick(60);
    expect(fake.paths).toHaveLength(1);
  });

  it("stops reconnecting on a 401", async () => {
    const fake = await fakeServer((_req, res) => json(res, 401, { error: "Unauthorized" }));
    const errors: unknown[] = [];
    track(
      createClient({ url: fake.url, ...instant, token: "t" }).overviewEvents({
        onRows: () => {},
        onError: (e) => errors.push(e),
      }),
    );
    await waitFor(() => errors.length > 0);
    await tick(60);
    expect(errors[0]).toBeInstanceOf(UnauthorizedError);
    expect(fake.paths).toHaveLength(1);
  });
});

// The M2 write path. These four methods are the only place the cockpit talks
// back to the server, and `sendMessage` is the odd one out: it POSTs and then
// reads an SSE stream for the whole agent turn, so it needs the same framing
// coverage the read streams get — plus proof it never reconnects.
describe("writes", () => {
  function bodyOf(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let buf = "";
      req.on("data", (c) => (buf += String(c)));
      req.on("end", () => resolve(buf));
    });
  }

  it("posts a message and resolves on the done frame", async () => {
    let seen: { method?: string; body?: string } = {};
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then((body) => {
        seen = { method: req.method, body };
        sseHead(res);
        res.write('data: {"type":"user_message","message":{"id":5}}\n\n');
        res.write('data: {"type":"sdk","sdk":{"type":"assistant"}}\n\n');
        res.write('data: {"type":"done"}\n\n');
      });
    });
    await createClient({ url: fake.url, token: "tok" }).sendMessage(7, "hi there");
    expect(fake.paths).toEqual(["/api/runs/7/messages"]);
    expect(seen.method).toBe("POST");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({ text: "hi there" });
    expect(fake.auth[0]).toBe("Bearer tok");
  });

  it("resolves on a clean end-of-stream with no done frame", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => {
        sseHead(res);
        res.write('data: {"type":"sdk","sdk":{}}\n\n');
        res.end();
      });
    });
    await expect(createClient({ url: fake.url }).sendMessage(1, "x")).resolves.toBeUndefined();
  });

  it("rejects with the message carried by an error frame", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => {
        sseHead(res);
        res.write('data: {"type":"error","error":"run is not accepting messages"}\n\n');
        res.end();
      });
    });
    await expect(createClient({ url: fake.url }).sendMessage(4, "x")).rejects.toMatchObject({
      name: "ApiError",
      message: "run is not accepting messages",
    });
  });

  it("surfaces a plain-text pre-stream failure as an ApiError", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
      });
    });
    const err = await createClient({ url: fake.url })
      .sendMessage(99, "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: "Not found" });
  });

  it("never retries a message POST — one connection even when the turn fails", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => {
        sseHead(res);
        res.write('data: {"type":"error","error":"boom"}\n\n');
        res.end();
      });
    });
    await createClient({ url: fake.url, minBackoffMs: 1, maxBackoffMs: 1, sleep: async () => {} })
      .sendMessage(2, "x")
      .catch(() => {});
    await tick(60);
    expect(fake.paths).toHaveLength(1);
  });

  it("creates a run from the posted body and returns the row", async () => {
    let seen: { method?: string; body?: string; contentType?: string } = {};
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then((body) => {
        seen = { method: req.method, body, contentType: req.headers["content-type"] };
        json(res, 201, { id: 51, goal: "ship it", status: "running", personaId: "executor" });
      });
    });
    const run = await createClient({ url: fake.url, token: "tok" }).createRun({
      goal: "ship it",
      personaId: "executor",
      cwdStrategy: "none",
    });
    expect(fake.paths).toEqual(["/api/runs"]);
    expect(seen.method).toBe("POST");
    expect(seen.contentType).toBe("application/json");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({
      goal: "ship it",
      personaId: "executor",
      cwdStrategy: "none",
    });
    expect(fake.auth[0]).toBe("Bearer tok");
    expect(run.id).toBe(51);
  });

  it("cancels with a PATCH action and returns the updated row", async () => {
    let seen: { method?: string; body?: string } = {};
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then((body) => {
        seen = { method: req.method, body };
        json(res, 200, { id: 44, goal: "g", status: "cancelled" });
      });
    });
    const run = await createClient({ url: fake.url, token: "tok" }).cancelRun(44);
    expect(fake.paths).toEqual(["/api/runs/44"]);
    expect(seen.method).toBe("PATCH");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({ action: "cancel" });
    expect(fake.auth[0]).toBe("Bearer tok");
    expect(run.status).toBe("cancelled");
  });

  // The action rides in the same flat object as the fields, because that is
  // the body the route reads.
  it("configures a run with one flat PATCH body", async () => {
    let seen: { method?: string; body?: string } = {};
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then((body) => {
        seen = { method: req.method, body };
        json(res, 200, { id: 44, goal: "g", status: "running", model: "sonnet", budgetMaxUsd: 5 });
      });
    });
    const run = await createClient({ url: fake.url, token: "tok" }).configureRun(44, {
      model: "sonnet",
      budgetMaxUsd: 5,
    });
    expect(fake.paths).toEqual(["/api/runs/44"]);
    expect(seen.method).toBe("PATCH");
    expect(JSON.parse(seen.body ?? "{}")).toEqual({
      action: "configure",
      model: "sonnet",
      budgetMaxUsd: 5,
    });
    expect(fake.auth[0]).toBe("Bearer tok");
    expect(run.model).toBe("sonnet");
  });

  // A cap the server refuses has to reach the operator as a line, not a throw
  // the cockpit swallows — the store turns this into the notice.
  it("throws the server's reason when a cap is refused", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => json(res, 400, { error: "Bad configure: budgetMaxTurns too small" }));
    });
    await expect(
      createClient({ url: fake.url }).configureRun(44, { budgetMaxTurns: 0 }),
    ).rejects.toMatchObject({ status: 400, message: "Bad configure: budgetMaxTurns too small" });
  });

  it("surfaces a JSON error from a write", async () => {
    const fake = await fakeServer((req, res) => {
      void bodyOf(req).then(() => json(res, 400, { error: "goal is required" }));
    });
    await expect(createClient({ url: fake.url }).createRun({ goal: "" })).rejects.toMatchObject({
      status: 400,
      message: "goal is required",
    });
  });

  it("unwraps { personas } and tolerates an empty payload", async () => {
    const fake = await fakeServer((req, res) => {
      if ((req.url ?? "") === "/api/personas" && fake.paths.length === 1)
        return json(res, 200, { personas: [{ id: "qa", name: "qa", budgetMaxTurns: 40 }] });
      return json(res, 200, {});
    });
    const c = createClient({ url: fake.url });
    const list = await c.personas();
    expect(list.map((p) => p.id)).toEqual(["qa"]);
    expect(await c.personas()).toEqual([]);
  });
});
