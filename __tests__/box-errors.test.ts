import { FetchError, ResponseError } from "@asciidev/box-sdk";
import { describe, expect, it } from "vitest";
import {
  classifyBoxError,
  normalizeBoxApiError,
  serializeBoxApiError,
} from "../lib/runner/box-errors";

function sdkError(status: number, body: Record<string, unknown> = {}): ResponseError {
  return new ResponseError(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

describe("Box API error normalization", () => {
  it.each([
    [401, "unauthorized"],
    [402, "billing-required"],
    [404, "not-found"],
    [500, "transient"],
  ] as const)("maps HTTP %i to %s", async (status, category) => {
    await expect(normalizeBoxApiError(sdkError(status, { code: "box_error", message: "request failed" }))).resolves.toMatchObject({
      category,
      status,
      code: "box_error",
      message: "request failed",
    });
  });

  it("distinguishes capacity exhaustion from ordinary rate limiting", () => {
    expect(classifyBoxError({ status: 429, code: "active_box_capacity", message: "maximum active boxes reached" })).toBe(
      "capacity"
    );
    expect(classifyBoxError({ status: 429, code: "rate_limited", message: "too many requests" })).toBe("rate-limited");
  });

  it("preserves safe Box details while redacting tokens and secret URLs", async () => {
    const normalized = await normalizeBoxApiError(
      sdkError(429, {
        code: "rate_limited",
        message: "Bearer abc.def_123 retry https://box.example/run?_token=secret-value api_key=top-secret",
        requestId: "req_123",
      })
    );
    expect(normalized).toMatchObject({ category: "rate-limited", status: 429, code: "rate_limited", requestId: "req_123" });
    const serialized = JSON.stringify(serializeBoxApiError(normalized));
    expect(serialized).not.toContain("abc.def_123");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("https://box.example");
  });

  it("normalizes SDK fetch failures and unknown thrown values without raw payloads", async () => {
    await expect(normalizeBoxApiError(new FetchError(new Error("offline"), "network unavailable"))).resolves.toMatchObject({
      category: "transient",
      status: 0,
    });
    await expect(normalizeBoxApiError({ token: "should-not-be-serialized" })).resolves.toEqual({
      category: "unknown",
      message: "Unknown Box API error",
    });
  });
});
