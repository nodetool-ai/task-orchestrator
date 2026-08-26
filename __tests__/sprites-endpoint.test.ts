import { describe, expect, it } from "vitest";

import { isSpritesDialEndpoint, parseSpritesDialEndpoint } from "../lib/worker-channel/dispatch-env";
import { spritesProxyUrl } from "../lib/runner/sprites-tunnel";

describe("parseSpritesDialEndpoint", () => {
  it("parses a valid sprite:// endpoint", () => {
    expect(parseSpritesDialEndpoint("sprite://to-run-42:8787/worker/channel")).toEqual({
      spriteName: "to-run-42",
      port: 8787,
    });
  });

  it("returns null when the path suffix is missing", () => {
    expect(parseSpritesDialEndpoint("sprite://to-run-42:8787")).toBeNull();
    expect(parseSpritesDialEndpoint("sprite://to-run-42:8787/worker")).toBeNull();
  });

  it("returns null when the port is missing", () => {
    expect(parseSpritesDialEndpoint("sprite://to-run-42/worker/channel")).toBeNull();
    expect(parseSpritesDialEndpoint("sprite://to-run-42:/worker/channel")).toBeNull();
  });

  it("returns null when the port is out of range", () => {
    expect(parseSpritesDialEndpoint("sprite://to-run-42:0/worker/channel")).toBeNull();
    expect(parseSpritesDialEndpoint("sprite://to-run-42:99999/worker/channel")).toBeNull();
    expect(parseSpritesDialEndpoint("sprite://to-run-42:65536/worker/channel")).toBeNull();
  });

  it("parses a sprite name that contains a dash and no colon", () => {
    expect(parseSpritesDialEndpoint("sprite://my-sprite-name:8787/worker/channel")).toEqual({
      spriteName: "my-sprite-name",
      port: 8787,
    });
  });

  it("returns null for a ws:// endpoint", () => {
    expect(parseSpritesDialEndpoint("ws://127.0.0.1:8787/worker/channel")).toBeNull();
    expect(parseSpritesDialEndpoint("ws://[::]:8787/worker/channel")).toBeNull();
  });

  it("isSpritesDialEndpoint matches sprite:// prefix", () => {
    expect(isSpritesDialEndpoint("sprite://to-run-42:8787/worker/channel")).toBe(true);
    expect(isSpritesDialEndpoint("ws://127.0.0.1:8787/worker/channel")).toBe(false);
  });
});

describe("spritesProxyUrl", () => {
  it("converts https baseUrl with trailing slash to wss proxy URL", () => {
    expect(spritesProxyUrl("to-run-1", "https://api.sprites.dev/v1/")).toBe(
      "wss://api.sprites.dev/v1/sprites/to-run-1/proxy",
    );
  });

  it("handles https without trailing slash", () => {
    expect(spritesProxyUrl("to-run-1", "https://api.sprites.dev/v1")).toBe(
      "wss://api.sprites.dev/v1/sprites/to-run-1/proxy",
    );
  });

  it("converts http to ws", () => {
    expect(spritesProxyUrl("to-run-1", "http://api.sprites.dev/v1")).toBe(
      "ws://api.sprites.dev/v1/sprites/to-run-1/proxy",
    );
  });

  it("encodes sprite name", () => {
    expect(spritesProxyUrl("a/b", "https://api.sprites.dev/v1")).toBe(
      "wss://api.sprites.dev/v1/sprites/a%2Fb/proxy",
    );
  });
});
