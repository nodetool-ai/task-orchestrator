// Codex model discovery: what the picker is offered, and what happens when the
// account's models endpoint is absent, unauthorized, slow, or junk. Every path
// must return a usable catalog — GET /api/providers has nothing else to serve.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexModelCatalog,
  codexModelName,
  codexModelsEndpoint,
  isCodexModelId,
  selectCodexModels,
  staticCodexModels,
  __test,
} from "../../lib/agent-backend/codex-models";

/** An OpenAI /models listing: the Codex-capable ids mixed in with everything
 *  else an account can see, in the arbitrary order the API returns. */
function modelsListing(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }),
  };
}

function noCredential() {
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
}

beforeEach(() => {
  __test.resetCache();
  // Neither the endpoint nor the credential may leak in from the host env:
  // an ambient OPENAI_API_KEY would make these tests reach the real API.
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("TASK_ORCH_CODEX_MODELS_URL", "");
  vi.stubEnv("TASK_ORCH_CODEX_MODEL_DISCOVERY", "");
  noCredential();
});

afterEach(() => {
  __test.resetCache();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the built-in catalog", () => {
  it("serves pi-ai's generated openai-codex list, newest first", () => {
    const ids = staticCodexModels().map((m) => m.id);
    // pi's openai-codex provider and this backend bill the same ChatGPT
    // subscription, so they must offer the same models — including the ones the
    // hand-written list in codex-backend.ts used to miss.
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.3-codex-spark");
    expect(ids.indexOf("gpt-5.6-sol")).toBeLessThan(ids.indexOf("gpt-5.5"));
    expect(ids.indexOf("gpt-5.5")).toBeLessThan(ids.indexOf("gpt-5.3-codex-spark"));
  });

  it("labels models the way pi does", () => {
    expect(codexModelName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    // An id pi-ai has never heard of still gets a presentable label.
    expect(codexModelName("gpt-5.7-nova")).toBe("GPT-5.7 Nova");
    expect(codexModelName("codex-mini-latest")).toBe("Codex Mini Latest");
  });
});

describe("selecting Codex-capable ids", () => {
  it("keeps the coding families and drops everything else", () => {
    expect(isCodexModelId("gpt-5.6-terra")).toBe(true);
    expect(isCodexModelId("codex-mini-latest")).toBe(true);
    expect(isCodexModelId("o4-mini")).toBe(true);
    expect(isCodexModelId("gpt-4o")).toBe(false);
    expect(isCodexModelId("text-embedding-3-large")).toBe(false);
    expect(isCodexModelId("whisper-1")).toBe(false);
  });

  it("drops the non-coding variants of a family it otherwise keeps", () => {
    // Same generation, wrong shape: these cannot run a coding turn.
    expect(isCodexModelId("gpt-5.6-audio")).toBe(false);
    expect(isCodexModelId("gpt-5-realtime-preview")).toBe(false);
    expect(isCodexModelId("gpt-5-chat-latest")).toBe(false);
  });

  it("de-duplicates and orders newest first", () => {
    const models = selectCodexModels(["gpt-5.4", "gpt-5.6-sol", "gpt-5.4", "  ", "gpt-5.5"]);
    expect(models.map((m) => m.id)).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"]);
  });
});

describe("codexModelsEndpoint", () => {
  it("defaults to the public API, honours OPENAI_BASE_URL and the explicit override", () => {
    expect(codexModelsEndpoint({})).toBe("https://api.openai.com/v1/models");
    expect(codexModelsEndpoint({ OPENAI_BASE_URL: "https://gateway.internal/v1/" })).toBe(
      "https://gateway.internal/v1/models"
    );
    vi.stubEnv("TASK_ORCH_CODEX_MODELS_URL", "https://proxy.internal/catalog");
    expect(codexModelsEndpoint({ OPENAI_BASE_URL: "https://gateway.internal/v1" })).toBe(
      "https://proxy.internal/catalog"
    );
  });
});

describe("codexModelCatalog", () => {
  it("fetches the account's catalog with the configured API key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    const fetchMock = vi.fn(async () =>
      modelsListing(["gpt-4o", "gpt-5.7-nova", "text-embedding-3-small", "gpt-5.6-sol"])
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await codexModelCatalog();

    expect(models).toEqual([
      { id: "gpt-5.7-nova", name: "GPT-5.7 Nova" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-openai");
    // A hung endpoint must not hang the request that asked for the catalog.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("prefers CODEX_API_KEY over OPENAI_API_KEY, as the backend's auth does", async () => {
    vi.stubEnv("CODEX_API_KEY", "sk-codex");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    const fetchMock = vi.fn(async () => modelsListing(["gpt-5.6-sol"]));
    vi.stubGlobal("fetch", fetchMock);

    await codexModelCatalog();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-codex");
  });

  it("serves the built-in catalog without a credential, and never calls out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // A ChatGPT-subscription deployment: no API key, and no catalog endpoint
    // that accepts the OAuth bearer.
    await expect(codexModelCatalog()).resolves.toEqual(staticCodexModels());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the built-in catalog when discovery is switched off", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("TASK_ORCH_CODEX_MODEL_DISCOVERY", "0");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(codexModelCatalog()).resolves.toEqual(staticCodexModels());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back on an unauthorized, unreachable, malformed or empty response", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const responses: Array<() => Promise<unknown>> = [
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      async () => {
        throw new Error("ENOTFOUND api.openai.com");
      },
      async () => ({ ok: true, status: 200, json: async () => ({ error: "nope" }) }),
      // Reachable and well-formed, but nothing this backend can run.
      async () => modelsListing(["gpt-4o", "whisper-1"]),
    ];

    for (const respond of responses) {
      __test.resetCache();
      vi.stubGlobal("fetch", vi.fn(respond));
      await expect(codexModelCatalog()).resolves.toEqual(staticCodexModels());
    }
  });

  it("caches a resolved catalog and re-resolves when the credential changes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-first");
    const fetchMock = vi.fn(async () => modelsListing(["gpt-5.6-sol"]));
    vi.stubGlobal("fetch", fetchMock);

    await codexModelCatalog();
    await codexModelCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A rotated key is a different catalog: the cache must not outlive it.
    vi.stubEnv("OPENAI_API_KEY", "sk-second");
    await codexModelCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return modelsListing(["gpt-5.6-sol"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([codexModelCatalog(), codexModelCatalog()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("keeps the credential itself out of the cache key", () => {
    const key = __test.cacheKey("https://api.openai.com/v1/models", "sk-super-secret");
    expect(key).not.toContain("sk-super-secret");
    expect(key).toContain("https://api.openai.com/v1/models");
  });
});
