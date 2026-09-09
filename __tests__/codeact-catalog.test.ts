import { describe, expect, it } from "vitest";
import { codeActCatalogForContext, describeCodeActCatalog } from "../lib/codeact/catalog";
import { executeAppCodeAct } from "../lib/codeact/app-bridge";
import { resolveServerTool } from "../lib/worker/server-tools";

const context = { author: "test" };
const sdkPath = "app.memory.search";

describe("CodeAct catalogue discovery", () => {
  it("finds an operation outside the initial bounded catalogue by name and query", async () => {
    const initial = codeActCatalogForContext(context);
    expect(initial.truncated).toBe(true);
    expect(initial.operations.some((op) => op.sdkPath === sdkPath)).toBe(false);
    const tool = (await resolveServerTool("codeact_catalog"))!;
    for (const filter of [{ names: [sdkPath] }, { query: sdkPath }]) {
      const result = await tool.execute(filter, context);
      const catalog = JSON.parse((result.content[0] as { text: string }).text);
      expect(catalog.operations).toEqual([expect.objectContaining({ sdkPath })]);
      expect(catalog.truncated).toBe(false);
    }
    const [operation] = describeCodeActCatalog([sdkPath]).operations;
    expect(operation.sdkPath).toBe(sdkPath);
    expect(describeCodeActCatalog([operation.aliases[0]]).operations).toContainEqual(operation);
  });

  it("searches the complete authorized catalogue from guest code", async () => {
    const result = await executeAppCodeAct({ context, code: `return {
      search: await catalog.search({query: '${sdkPath}'}),
      describe: await catalog.describe({names: ['${sdkPath}']})
    };` });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    expect(result.value).toMatchObject({
      search: [expect.objectContaining({ sdkPath })],
      describe: [expect.objectContaining({ sdkPath })],
    });
  });

  it("keeps an empty describe request empty", async () => {
    expect(describeCodeActCatalog([]).operations).toEqual([]);
    const result = await executeAppCodeAct({ context, code: "return await catalog.describe();" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toEqual([]);
  });

  it("does not disclose denied operations through filtered or guest discovery", async () => {
    expect(codeActCatalogForContext({ ...context, capabilities: [] }, {}, { names: [sdkPath] }).operations).toEqual([]);
    const result = await executeAppCodeAct({
      context,
      resolveContext: async () => ({ ...context, capabilities: [] }),
      code: `return await catalog.describe({names: ['${sdkPath}']});`,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toEqual([]);
  });
});
