// __tests__/github-client.test.ts
//
// The orchestrator's in-process GitHub client (lib/github-client.ts). Covers
// token resolution (GH_TOKEN, then GITHUB_TOKEN) and the readable error
// mapping. No real network calls are made.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  githubToken,
  describeGithubError,
  GH_REQUEST_TIMEOUT_MS,
} from "../lib/github-client";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("githubToken", () => {
  it("reads GH_TOKEN first", () => {
    vi.stubEnv("GH_TOKEN", "gh-primary");
    vi.stubEnv("GITHUB_TOKEN", "gh-fallback");
    expect(githubToken()).toBe("gh-primary");
  });

  it("falls back to GITHUB_TOKEN when GH_TOKEN is unset", () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "gh-fallback");
    expect(githubToken()).toBe("gh-fallback");
  });

  it("is undefined when neither is set", () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(githubToken()).toBeUndefined();
  });
});

describe("describeGithubError", () => {
  it("surfaces the HTTP status and the API message", () => {
    const err = {
      status: 404,
      message: "Not Found",
      response: { data: { message: "Not Found" } },
    };
    expect(describeGithubError(err)).toContain("HTTP 404");
    expect(describeGithubError(err)).toContain("Not Found");
  });

  it("notes a timeout for aborted requests", () => {
    const err = { name: "AbortError", message: "The operation was aborted" };
    const text = describeGithubError(err);
    expect(text).toContain(String(GH_REQUEST_TIMEOUT_MS / 1000));
  });

  it("stringifies unknown shapes", () => {
    expect(describeGithubError("boom")).toBe("boom");
  });
});
