import { describe, expect, it } from "vitest";
import { parseProviderQualifiedModel } from "@/lib/model-id";

describe("parseProviderQualifiedModel", () => {
  it("keeps slashes inside provider model ids", () => {
    expect(parseProviderQualifiedModel("openrouter/z-ai/glm-4.5")).toEqual({
      provider: "openrouter",
      id: "z-ai/glm-4.5",
    });
  });

  it("defaults bare legacy model ids to anthropic", () => {
    expect(parseProviderQualifiedModel("claude-sonnet-4-6")).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    });
  });
});
