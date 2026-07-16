import { describe, expect, it } from "vitest";

import {
  boxChannelDialEndpoint,
  boxListenEndpoint,
  parseBoxHostUrl,
} from "../lib/worker-channel/dispatch-env";
import { resolveDialTarget } from "../lib/worker-channel/connection";

describe("box worker endpoints", () => {
  it("binds the fixed channel TCP port", () => {
    expect(boxListenEndpoint()).toBe("tcp:0.0.0.0:8787");
  });

  describe("parseBoxHostUrl", () => {
    it("extracts the origin and token from a bare `host` URL", () => {
      const parsed = parseBoxHostUrl("https://sous-scarp-toneme-8787.on.ascii.dev?_token=deadbeef01");
      expect(parsed).toEqual({
        origin: "https://sous-scarp-toneme-8787.on.ascii.dev",
        token: "deadbeef01",
      });
    });

    it("tolerates the firewall/registration log lines `host` prints first", () => {
      const stdout = [
        "Opening firewall for port 8787...",
        "Registering public URL for port 8787...",
        "https://sous-scarp-toneme-8787.on.ascii.dev?_token=abc_DEF-123",
      ].join("\n");
      expect(parseBoxHostUrl(stdout)).toEqual({
        origin: "https://sous-scarp-toneme-8787.on.ascii.dev",
        token: "abc_DEF-123",
      });
    });

    it("returns null when no hosted URL is present", () => {
      expect(parseBoxHostUrl("host: command failed")).toBeNull();
      expect(parseBoxHostUrl("https://sous-scarp-toneme-8787.on.ascii.dev")).toBeNull(); // no token
      expect(parseBoxHostUrl("")).toBeNull();
    });
  });

  describe("boxChannelDialEndpoint", () => {
    it("builds a wss channel URL carrying the token as _port_auth", () => {
      expect(
        boxChannelDialEndpoint("https://sous-scarp-toneme-8787.on.ascii.dev", "tok_123")
      ).toBe("wss://sous-scarp-toneme-8787.on.ascii.dev/worker/channel?_port_auth=tok_123");
    });

    it("round-trips through the dialer into a cookie and a clean URL", () => {
      const parsed = parseBoxHostUrl("https://box-8787.on.ascii.dev?_token=T0KEN")!;
      const endpoint = boxChannelDialEndpoint(parsed.origin, parsed.token);
      const target = resolveDialTarget(endpoint);
      expect(target.url).toBe("wss://box-8787.on.ascii.dev/worker/channel");
      expect(target.headers).toEqual({ Cookie: "_port_auth=T0KEN" });
    });
  });
});

describe("resolveDialTarget", () => {
  it("lifts _port_auth into a cookie and dials the clean URL", () => {
    const target = resolveDialTarget(
      "wss://box-8787.on.ascii.dev/worker/channel?_port_auth=abc123"
    );
    expect(target.url).toBe("wss://box-8787.on.ascii.dev/worker/channel");
    expect(target.headers).toEqual({ Cookie: "_port_auth=abc123" });
  });

  it("preserves any other query params alongside the auth cookie", () => {
    const target = resolveDialTarget(
      "wss://box-8787.on.ascii.dev/worker/channel?foo=bar&_port_auth=abc123"
    );
    expect(target.url).toBe("wss://box-8787.on.ascii.dev/worker/channel?foo=bar");
    expect(target.headers).toEqual({ Cookie: "_port_auth=abc123" });
  });

  it("passes a plain Fly/Docker tcp endpoint through unchanged with no headers", () => {
    const endpoint = "ws://[fdaa:0:1::3]:8787/worker/channel";
    expect(resolveDialTarget(endpoint)).toEqual({ url: endpoint, headers: {} });
  });

  it("passes a local unix-socket endpoint through unchanged", () => {
    const endpoint = "ws+unix:///run/task-orch/wi_abc.sock:/worker/channel";
    expect(resolveDialTarget(endpoint)).toEqual({ url: endpoint, headers: {} });
  });
});
