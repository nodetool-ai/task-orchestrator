import { describe, expect, it } from "vitest";
import {
  cloudflaredAssetName,
  cloudflaredCachePath,
  cloudflaredDownloadUrl,
} from "../lib/cloudflared";

describe("cloudflaredAssetName", () => {
  it("maps linux x64/arm64 to the raw release binaries", () => {
    expect(cloudflaredAssetName("linux", "x64")).toBe("cloudflared-linux-amd64");
    expect(cloudflaredAssetName("linux", "arm64")).toBe("cloudflared-linux-arm64");
  });

  it("throws on an unsupported CPU arch", () => {
    expect(() => cloudflaredAssetName("linux", "ia32")).toThrow(/arch/i);
  });

  it("throws on a non-linux platform (no raw auto-install)", () => {
    expect(() => cloudflaredAssetName("win32", "x64")).toThrow(/linux/i);
    expect(() => cloudflaredAssetName("darwin", "arm64")).toThrow(/linux/i);
  });
});

describe("cloudflaredDownloadUrl", () => {
  it("uses the stable latest/download redirect for 'latest'", () => {
    expect(cloudflaredDownloadUrl("latest", "linux", "x64")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    );
  });

  it("pins to a specific release tag when given a version", () => {
    expect(cloudflaredDownloadUrl("2025.1.0", "linux", "arm64")).toBe(
      "https://github.com/cloudflare/cloudflared/releases/download/2025.1.0/cloudflared-linux-arm64"
    );
  });
});

describe("cloudflaredCachePath", () => {
  it("is versioned and ends in the asset name", () => {
    const p = cloudflaredCachePath("latest", "linux", "x64");
    expect(p).toContain("/.cache/task-orchestrator/cloudflared/latest/");
    expect(p.endsWith("cloudflared-linux-amd64")).toBe(true);
  });

  it("changes path when the version changes (clean re-download)", () => {
    expect(cloudflaredCachePath("latest", "linux", "x64")).not.toBe(
      cloudflaredCachePath("2025.1.0", "linux", "x64")
    );
  });
});
