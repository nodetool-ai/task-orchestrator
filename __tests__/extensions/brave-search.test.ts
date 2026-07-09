import { afterEach, describe, expect, it, vi } from "vitest";

import { braveSearchExtension } from "../../lib/extensions/brave-search";
import { makeRegistrar } from "../helpers/fake-registrar";

function registeredTool() {
  const r = makeRegistrar();
  braveSearchExtension()(r.reg);
  const tool = r.tools.get("brave__web_search");
  if (!tool) throw new Error("brave__web_search was not registered");
  return tool;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("braveSearchExtension", () => {
  it("registers the Brave web search tool", () => {
    const tool = registeredTool();
    expect(tool.label).toBe("Brave Web Search");
    expect(tool.description).toMatch(/Brave Search/);
    expect((tool.parameters as any).properties.query).toBeDefined();
  });

  it("fails closed when no Brave API key is configured", async () => {
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRAVE_API_KEY;

    const result = await registeredTool().execute("call-1", { query: "test" });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/BRAVE_SEARCH_API_KEY/);
  });

  it("calls Brave Web Search with server-side auth and returns summarized results", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-test-key");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        query: { original: "task orchestrator", more_results_available: true },
        web: {
          results: [{
            title: "Task Orchestrator",
            url: "https://example.com/task-orchestrator",
            description: "A task system.",
            extra_snippets: ["Extra context"],
          }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await registeredTool().execute("call-1", {
      query: "task orchestrator",
      count: 5,
      freshness: "pw",
      country: "US",
      search_lang: "en",
      extra_snippets: true,
    });

    expect(result.isError).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(url.searchParams.get("q")).toBe("task orchestrator");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("freshness")).toBe("pw");
    expect(url.searchParams.get("extra_snippets")).toBe("true");
    expect((init.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-test-key");

    const body = JSON.parse((result.content[0] as any).text);
    expect(body.web.results).toEqual([{
      title: "Task Orchestrator",
      url: "https://example.com/task-orchestrator",
      description: "A task system.",
      age: null,
      extra_snippets: ["Extra context"],
    }]);
    expect(body.query.more_results_available).toBe(true);
  });
});
