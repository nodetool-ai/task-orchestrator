import { describe, expect, it, vi } from "vitest";

import { makeSpritesClient, SpritesApiError } from "../lib/runner/sprites-client";

const TOKEN = "test-token-123";
const BASE_URL = "https://api.sprites.dev/v1";

function makeFetchMock(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): typeof fetch {
  return (async (url: unknown, init?: unknown) => handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
}

/** One HTTP chunk per frame: [streamId, payload]. */
function framedResponse(frames: Array<[number, string]>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [id, payload] of frames) {
        controller.enqueue(Buffer.concat([Buffer.from([id]), Buffer.from(payload, "latin1")]));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

describe("SpritesClient", () => {
  it("createSprite sends correct URL, method, headers and body", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = makeFetchMock(async (url, init) => {
      captured = { url, init };
      expect(url).toBe(`${BASE_URL}/sprites`);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers.Accept).toBe("application/json");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ name: "to-run-1", url_settings: { auth: "sprite" } });
      return jsonResponse({
        id: "abc",
        name: "to-run-1",
        status: "running",
        created_at: "2026-01-01T00:00:00Z",
        url: "https://to-run-1.sprites.app",
      });
    });

    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const sprite = await client.createSprite({ name: "to-run-1", urlSettings: { auth: "sprite" } });
    expect(sprite.name).toBe("to-run-1");
    expect(sprite.status).toBe("running");
    expect(sprite.createdAt).toBeInstanceOf(Date);
    expect(captured).toBeDefined();
  });

  it("createSprite omits Content-Type when no body? (has body, so should have)", async () => {
    // This test verifies that Content-Type is present when body is present (create has body)
    const fetchImpl = makeFetchMock(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      return jsonResponse({ name: "x", status: "cold", created_at: "2026-01-01T00:00:00Z" });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await client.createSprite({ name: "x" });
  });

  it("getSprite 404 returns null", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1`);
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      // GET has no body → no Content-Type
      expect(headers["Content-Type"]).toBeUndefined();
      return textResponse("not found", 404);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const result = await client.getSprite("to-run-1");
    expect(result).toBeNull();
  });

  it("getService returns the typed service state and treats 404 as absent", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/services/worker`);
      expect(init.method).toBe("GET");
      return jsonResponse({
        name: "worker", cmd: "node", args: ["dist/run-worker.js"], env: { A: "b" }, dir: "/work", needs: [],
        state: { status: "running", pid: 123, started_at: "2026-08-27T10:00:00Z", next_restart_at: null },
      });
    });
    const service = await makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN }).getService("to-run-1", "worker");
    expect(service).toMatchObject({ name: "worker", cmd: "node", state: { status: "running", pid: 123, startedAt: "2026-08-27T10:00:00Z" } });

    const missing = makeSpritesClient({
      fetchImpl: makeFetchMock(async () => textResponse("not found", 404)), baseUrl: BASE_URL, token: TOKEN,
    });
    await expect(missing.getService("to-run-1", "worker")).resolves.toBeNull();

    // Unreadable answers throw (inspect maps a throw to unknown); only 404 is "absent".
    const noState = makeSpritesClient({ fetchImpl: makeFetchMock(async () => jsonResponse({ name: "worker", cmd: "node" })), baseUrl: BASE_URL, token: TOKEN });
    await expect(noState.getService("to-run-1", "worker")).rejects.toThrow(/no state.status/);
    const empty = makeSpritesClient({ fetchImpl: makeFetchMock(async () => textResponse("", 200)), baseUrl: BASE_URL, token: TOKEN });
    await expect(empty.getService("to-run-1", "worker")).rejects.toThrow(/empty response/);
  });

  it("deleteSprite 404 does not throw", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1`);
      expect(init.method).toBe("DELETE");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["Content-Type"]).toBeUndefined();
      return textResponse("not found", 404);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await expect(client.deleteSprite("to-run-1")).resolves.toBeUndefined();
  });

  it("listAllSprites pages across two pages", async () => {
    const calls: string[] = [];
    const fetchImpl = makeFetchMock(async (url, _init) => {
      calls.push(url);
      if (url.includes("continuation_token=tok123")) {
        return jsonResponse({
          sprites: [{ name: "to-run-2", status: "running", created_at: "2026-01-02T00:00:00Z" }],
          has_more: false,
          next_continuation_token: null,
        });
      }
      // First page
      expect(url).toBe(`${BASE_URL}/sprites?prefix=to-run-&max_results=50`);
      return jsonResponse({
        sprites: [{ name: "to-run-1", status: "running", created_at: "2026-01-01T00:00:00Z" }],
        has_more: true,
        next_continuation_token: "tok123",
      });
    });

    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const all = await client.listAllSprites("to-run-");
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe("to-run-1");
    expect(all[1].name).toBe("to-run-2");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("continuation_token=tok123");
  });

  it("putService sends correct URL, method, body", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/services/worker`);
      expect(init.method).toBe("PUT");
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        cmd: "node",
        args: ["dist/run-worker.js", "1"],
        env: { FOO: "bar" },
        dir: "/home/user/worker",
      });
      return jsonResponse({ name: "worker", cmd: "node", args: [], needs: [], http_port: null });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await client.putService("to-run-1", "worker", {
      cmd: "node",
      args: ["dist/run-worker.js", "1"],
      env: { FOO: "bar" },
      dir: "/home/user/worker",
    });
  });

  it("setNetworkPolicy sends rules array", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/policy/network`);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        rules: [
          { domain: "github.com", action: "allow" },
          { domain: "*.npmjs.org", action: "allow" },
        ],
      });
      return jsonResponse({ rules: body.rules });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await client.setNetworkPolicy("to-run-1", {
      rules: [
        { domain: "github.com", action: "allow" },
        { domain: "*.npmjs.org", action: "allow" },
      ],
    });
  });

  it("TimeoutError maps to SpritesApiError status 0", async () => {
    const fetchImpl = makeFetchMock(async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await expect(client.getSprite("to-run-1")).rejects.toThrow(SpritesApiError);
    try {
      await client.getSprite("to-run-1");
    } catch (err) {
      expect(err).toBeInstanceOf(SpritesApiError);
      expect((err as SpritesApiError).status).toBe(0);
      expect((err as SpritesApiError).body).toContain("timed out");
    }
  });

  it("GET without body omits Content-Type", async () => {
    const fetchImpl = makeFetchMock(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      return jsonResponse([]);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await client.listAllSprites();
  });

  it("POST with body includes Content-Type", async () => {
    const fetchImpl = makeFetchMock(async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      return jsonResponse({ name: "x", status: "cold", created_at: "2026-01-01T00:00:00Z" });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await client.createSprite({ name: "x" });
  });

  it("exec sends the line as sh -c argv in query params and parses the framed stream", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toContain("/sprites/to-run-1/exec?");
      expect(url).toContain("cmd=sh&cmd=-c&cmd=node+%2B+version");
      expect(url).toContain("dir=%2Fhome%2Fuser");
      expect(url).toContain("env=FOO%3Dbar");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect(init.body).toBeUndefined();
      return framedResponse([[1, "v20"], [3, "\0"]]);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const res = await client.exec("to-run-1", {
      cmd: "node + version",
      dir: "/home/user",
      env: { FOO: "bar" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("v20");
  });

  it("exec drops timeout_ms and uses query params only", async () => {
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).not.toContain("timeout_ms");
      expect(url).not.toContain("timeoutMs");
      expect(init.body).toBeUndefined();
      return framedResponse([[2, "oops"], [3, "\x01"]]);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const res = await client.exec("to-run-1", { cmd: "false", timeoutMs: 5000 });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toBe("oops");
  });

  it("startService handles NDJSON stream without JSON parse error", async () => {
    const ndjson = `{"type":"started","timestamp":123}\n{"type":"complete","timestamp":124}\n`;
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/services/worker/start`);
      expect(init.method).toBe("POST");
      return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await expect(client.startService("to-run-1", "worker")).resolves.toBeUndefined();
  });

  it("checkpoint handles NDJSON and resolves id via listCheckpoints (hint as fallback)", async () => {
    const ndjson = `{"type":"info","data":"Creating checkpoint...","time":"2026-01-01T00:00:00Z"}\n{"type":"complete","data":"Checkpoint v99 created","time":"2026-01-01T00:00:01Z"}\n`;
    let call = 0;
    const fetchImpl = makeFetchMock(async (url, init) => {
      call++;
      if (call === 1) {
        expect(url).toBe(`${BASE_URL}/sprites/to-run-1/checkpoint`);
        expect(init.method).toBe("POST");
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ comment: "bootstrap test" });
        return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      // Second call: listCheckpoints after NDJSON
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/checkpoints`);
      expect(init.method).toBe("GET");
      return jsonResponse([
        { id: "v99", create_time: "2026-01-01T00:00:01Z", comment: "bootstrap test" },
        { id: "v98", create_time: "2026-01-01T00:00:00Z", comment: "bootstrap test" },
      ]);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const cp = await client.checkpoint("to-run-1", "bootstrap test");
    expect(cp.id).toBe("v99");
    expect(cp.comment).toBe("bootstrap test");
  });

  it("checkpoint falls back to hint when listCheckpoints empty", async () => {
    const ndjson = `{"type":"info","data":"Creating checkpoint...","time":"2026-01-01T00:00:00Z"}\n{"type":"complete","data":"Checkpoint v42 created","time":"2026-01-01T00:00:01Z"}\n`;
    let call = 0;
    const fetchImpl = makeFetchMock(async (url) => {
      call++;
      if (call === 1) return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      // listCheckpoints returns empty
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/checkpoints`);
      return jsonResponse([]);
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const cp = await client.checkpoint("to-run-1", "hint-only");
    expect(cp.id).toBe("v42");
  });

  it("getServiceLogs concatenates NDJSON stdout/stderr", async () => {
    const ndjson = `{"type":"stdout","data":"hello\\n","timestamp":1}\n{"type":"stderr","data":"warn\\n","timestamp":2}\n{"type":"complete","timestamp":3}\n`;
    const fetchImpl = makeFetchMock(async () => {
      return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const logs = await client.getServiceLogs("to-run-1", "worker");
    expect(logs).toBe("hello\nwarn\n");
  });

  it("listSprites with minimal fields leaves status undefined", async () => {
    const fetchImpl = makeFetchMock(async () => {
      return jsonResponse({
        sprites: [{ name: "to-run-1", org_slug: "my-org", updated_at: "2026-01-01T00:00:00Z" }],
        has_more: false,
      });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    const page = await client.listSprites({ prefix: "to-run-" });
    expect(page.sprites[0].name).toBe("to-run-1");
    expect(page.sprites[0].status).toBeUndefined();
    expect(page.sprites[0].createdAt).toBeNull();
  });
});

describe("parseExecFrames", () => {
  it("routes stdout, stderr and the exit byte", async () => {
    const { parseExecFrames } = await import("../lib/runner/sprites-client");
    const f = (id: number, s: string) => Buffer.concat([Buffer.from([id]), Buffer.from(s)]);
    const r = parseExecFrames([f(1, "a\nb\n"), f(1, "noline"), f(2, "e\n"), Buffer.from([3, 5])]);
    expect(r).toEqual({ exitCode: 5, stdout: "a\nb\nnoline", stderr: "e\n" });
  });
});

describe("putService", () => {
  it("accepts the NDJSON event stream the API answers with", async () => {
    const ndjson = `{"type":"started","timestamp":1}\n{"type":"complete","log_files":{},"timestamp":2}\n`;
    const fetchImpl = makeFetchMock(async (url, init) => {
      expect(url).toBe(`${BASE_URL}/sprites/to-run-1/services/worker`);
      expect(init.method).toBe("PUT");
      return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    });
    const client = makeSpritesClient({ fetchImpl, baseUrl: BASE_URL, token: TOKEN });
    await expect(client.putService("to-run-1", "worker", { cmd: "node", args: [], env: {}, dir: "/tmp" })).resolves.toBeUndefined();
  });
});
