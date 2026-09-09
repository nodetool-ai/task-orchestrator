import { describe, expect, it } from "vitest";
import { APP_API_DESCRIPTORS } from "../lib/app-api";
import { OPERATION_MANIFEST } from "../lib/codeact/operation-manifest";

describe("CodeAct SDK coverage parity", () => {
  it("exposes every manifest SDK obligation through a descriptor", () => {
    const paths = new Set(APP_API_DESCRIPTORS.map((entry) => entry.sdkPath));
    const missing = OPERATION_MANIFEST
      .filter((entry) => entry.coverage === "sdk")
      .map((entry) => entry.sdkNamespace)
      .filter((path): path is string => Boolean(path))
      .filter((path) => !paths.has(path));
    expect(missing).toEqual([]);
  });

  it("marks checkout access as worker-only and administration as explicit capability work", () => {
    expect(APP_API_DESCRIPTORS.find((entry) => entry.sdkPath === "app.repo.readFile")).toMatchObject({
      executionLocation: "worker",
      serverSafe: false,
    });
    expect(APP_API_DESCRIPTORS.find((entry) => entry.sdkPath === "app.admin.users.create")).toMatchObject({
      serverSafe: false,
      capabilities: expect.arrayContaining(["admin:users:write"]),
    });
  });

  it("does not advertise plaintext credential fields in credential operations", () => {
    for (const path of ["app.tokens.create", "app.discord.upsertBot", "app.admin.users.magicLink"]) {
      const descriptor = APP_API_DESCRIPTORS.find((entry) => entry.sdkPath === path);
      expect(descriptor?.description).not.toMatch(/return|expose|emit.*token/i);
    }
  });
});
