// lib/extensions/brave-search.ts
//
// Server-side Brave Search tool for chat and agent runs. The API token stays in
// process env and is never passed as a model-visible parameter.

import { Type } from "typebox";

import type { ExtensionFactory } from "./types";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RESULTS = 20;
const REQUEST_TIMEOUT_MS = 20_000;

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}

function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function apiKey(): string | null {
  return process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY || null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeResult(result: any) {
  return {
    title: result.title ?? null,
    url: result.url ?? null,
    description: result.description ?? null,
    age: result.age ?? null,
    profile: result.profile
      ? {
          name: result.profile.name ?? null,
          url: result.profile.url ?? null,
          long_name: result.profile.long_name ?? null,
        }
      : undefined,
    extra_snippets: Array.isArray(result.extra_snippets) ? result.extra_snippets : undefined,
  };
}

function summarizeLocation(result: any) {
  return {
    id: result.id ?? null,
    title: result.title ?? null,
    url: result.url ?? null,
    description: result.description ?? null,
    address: result.address ?? null,
    coordinates: result.coordinates ?? null,
  };
}

function summarizeResponse(body: any) {
  return {
    query: body.query ?? null,
    web: {
      results: Array.isArray(body.web?.results) ? body.web.results.map(summarizeResult) : [],
    },
    news: body.news
      ? {
          results: Array.isArray(body.news.results) ? body.news.results.map(summarizeResult) : [],
        }
      : undefined,
    discussions: body.discussions
      ? {
          results: Array.isArray(body.discussions.results) ? body.discussions.results.map(summarizeResult) : [],
        }
      : undefined,
    videos: body.videos
      ? {
          results: Array.isArray(body.videos.results) ? body.videos.results.map(summarizeResult) : [],
        }
      : undefined,
    locations: body.locations
      ? {
          results: Array.isArray(body.locations.results) ? body.locations.results.map(summarizeLocation) : [],
        }
      : undefined,
    rich: body.rich ?? undefined,
  };
}

export const braveSearchExtension = (): ExtensionFactory => (reg) => {
  reg.registerTool({
    name: "brave__web_search",
    label: "Brave Web Search",
    description:
      "Search the web with Brave Search. Use this when current public web information, source URLs, or freshness filtering would help answer the user.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query. Brave search operators like site: and filetype: may be included." }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Maximum results to return. Defaults to 10; Brave web search caps this at 20." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 9, description: "Page offset, 0-based. Check query.more_results_available before requesting another page." })),
      freshness: Type.Optional(Type.String({ description: "Optional freshness filter: pd, pw, pm, py, or a custom range like 2024-01-01to2024-01-31." })),
      country: Type.Optional(Type.String({ minLength: 2, maxLength: 2, description: "Optional 2-letter country code, e.g. US or DE." })),
      search_lang: Type.Optional(Type.String({ minLength: 2, description: "Optional content language, usually an ISO 639-1 code like en or de." })),
      ui_lang: Type.Optional(Type.String({ minLength: 2, description: "Optional UI language for response metadata, e.g. en-US." })),
      safesearch: Type.Optional(Type.Union([
        Type.Literal("off"),
        Type.Literal("moderate"),
        Type.Literal("strict"),
      ], { description: "Adult content filtering. Defaults to Brave's moderate setting." })),
      extra_snippets: Type.Optional(Type.Boolean({ description: "Include additional excerpts per result when available." })),
    }),
    execute: async (_id, params: any) => {
      const token = apiKey();
      if (!token) {
        return errResult("Brave Search is not configured. Set BRAVE_SEARCH_API_KEY in the server/worker environment.");
      }

      const query = stringValue(params.query);
      if (!query) return errResult("query must be a non-empty string.");

      const url = new URL(ENDPOINT);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(params.count ?? 10, MAX_RESULTS)));
      if (params.offset != null) url.searchParams.set("offset", String(params.offset));
      for (const key of ["freshness", "country", "search_lang", "ui_lang", "safesearch"] as const) {
        const value = stringValue(params[key]);
        if (value) url.searchParams.set(key, value);
      }
      if (params.extra_snippets === true) url.searchParams.set("extra_snippets", "true");

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          signal: abort.signal,
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": token,
          },
        });
        const text = await res.text();
        let body: any = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        if (!res.ok) {
          const message =
            typeof body === "object" && body
              ? JSON.stringify(body)
              : String(body || res.statusText);
          return errResult(`Brave Search request failed (${res.status}): ${message}`);
        }
        return ok(summarizeResponse(body));
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return errResult("Brave Search request timed out.");
        }
        return errResult(err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
      }
    },
  });
};
