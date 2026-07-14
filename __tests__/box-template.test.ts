import { describe, expect, it } from "vitest";
import { parseBoxTemplateManifest } from "../lib/runner/box-template";

const valid = {
  formatVersion: 1,
  workerBuildSha: "3b4a234",
  workerProtocolVersion: 1,
  repository: "acme/service",
  repositoryPath: "/home/user/service",
};

describe("parseBoxTemplateManifest", () => {
  it("accepts a compatible manifest and forward-compatible fields", () => {
    expect(parseBoxTemplateManifest(JSON.stringify({ ...valid, nextField: true }))).toEqual(valid);
    const { formatVersion: _oldFormatVersion, ...oldManifest } = valid;
    expect(parseBoxTemplateManifest(JSON.stringify(oldManifest))).toEqual(valid);
  });

  it("rejects malformed and incomplete input", () => {
    expect(() => parseBoxTemplateManifest("nope")).toThrow(/valid JSON/);
    expect(() => parseBoxTemplateManifest(JSON.stringify({ ...valid, workerBuildSha: "" }))).toThrow(/workerBuildSha/);
  });

  it("requires a repository path beneath the Box user home", () => {
    expect(() => parseBoxTemplateManifest(JSON.stringify({ ...valid, repositoryPath: "/tmp/service" }))).toThrow(
      /under \/home\/user/
    );
  });

  it("rejects incompatible worker protocols before launch", () => {
    expect(() => parseBoxTemplateManifest(JSON.stringify({ ...valid, workerProtocolVersion: 2 }))).toThrow(
      /incompatible/
    );
  });
});
