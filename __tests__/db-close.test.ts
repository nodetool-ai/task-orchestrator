import { afterEach, describe, expect, it, vi } from "vitest";

import { closeDb } from "../db";

describe("closeDb", () => {
  const originalClient = globalThis.__tasksPg;
  const originalDb = globalThis.__tasksDb;

  afterEach(() => {
    globalThis.__tasksPg = originalClient;
    globalThis.__tasksDb = originalDb;
  });

  it("does not create a database connection just to close it", async () => {
    globalThis.__tasksPg = undefined;
    globalThis.__tasksDb = undefined;

    await expect(closeDb()).resolves.toBeUndefined();
    expect(globalThis.__tasksPg).toBeUndefined();
  });

  it("awaits and clears an existing client", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    globalThis.__tasksPg = { end } as never;
    globalThis.__tasksDb = {} as never;

    await closeDb();
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
    expect(globalThis.__tasksPg).toBeUndefined();
    expect(globalThis.__tasksDb).toBeUndefined();
  });
});
