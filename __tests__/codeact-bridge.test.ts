import { describe, expect, it } from "vitest";
import {
  executeCodeAct,
  extractCodeActLinks,
  MemoryCodeActReceiptStore,
} from "../lib/codeact/bridge";
import { executeAppCodeAct } from "../lib/codeact/app-bridge";
import { codeActModelText, presentCodeActReceipt } from "../lib/codeact/presentation";

describe("CodeAct execution bridge", () => {
  it.each([
    ['throw new Error("specific failure")', "Error", "specific failure"],
    ['const = ;', "SyntaxError", undefined],
  ])("preserves guest errors in receipts and model output: %s", async (code, name, message) => {
    const receipts = new MemoryCodeActReceiptStore();
    const result = await executeCodeAct({ code: code!, receipts });
    const model = JSON.parse(codeActModelText(presentCodeActReceipt(result.receipt)));
    expect(model.status).toBe("failed");
    expect(model.error.name).toBe(name);
    expect(model.error.message).toBeTruthy();
    if (message) expect(model.error.message).toBe(message);
    expect(receipts.executions.get(result.executionId)?.error).toEqual(result.receipt.error);
  });

  it("returns bounded structured output and persists the terminal receipt", async () => {
    const receipts = new MemoryCodeActReceiptStore();
    const result = await executeCodeAct({
      code: "console.log('diagnostic'); output.text({ answer: 42 }); return { ok: true };",
      receipts,
    });

    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.outputs).toEqual([{ kind: "text", value: { answer: 42 } }]);
    expect(result.receipt.diagnostics).toEqual([{ level: "log", values: ["diagnostic"] }]);
    expect(result.receipt.source).toContain("console.log");
    expect(result.receipt.durationMs).toEqual(expect.any(Number));
    expect(result.receipt.result).toEqual({ ok: true });
    expect(receipts.executions.get(result.executionId)).toMatchObject({ status: "completed" });
  });

  it("does not start guest work for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeCodeAct({ code: "while (true) {}", signal: controller.signal });

    expect(result.receipt.status).toBe("cancelled");
    expect(result.status).toBe("terminated");
  });

  it("re-resolves capability policy for every subcall and records the denied outcome", async () => {
    let resolutions = 0;
    const result = await executeAppCodeAct({
      code: "return await app.tasks.list({});",
      context: { author: "test", capabilities: ["app:list_tasks"] },
      resolveContext: async () => {
        resolutions += 1;
        return resolutions === 1
          ? { author: "test", capabilities: ["app:list_tasks"] }
          : { author: "test", capabilities: [] };
      },
    });

    expect(resolutions).toBeGreaterThanOrEqual(2);
    expect(result.receipt.status).toBe("failed");
    expect(result.receipt.subcalls).toHaveLength(1);
    expect(result.receipt.subcalls[0]).toMatchObject({
      operation: "app.tasks.list",
      status: "failed",
      durationMs: expect.any(Number),
    });
    expect(result.receipt.subcalls[0].error).toContain("not authorized");
  });

  it("builds bounded transcript presentation with partial outcomes and links", () => {
    const links = extractCodeActLinks({
      task_id: "T-20260908-0004",
      pr_url: "https://github.com/acme/repo/pull/7",
    });
    const presentation = presentCodeActReceipt({
      executionId: "execution",
      title: "Triage",
      source: "return 1",
      sourceSha256: "hash",
      status: "failed",
      result: { ok: false },
      outputs: [],
      diagnostics: [],
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(10).toISOString(),
      durationMs: 10,
      links,
      subcalls: [
        {
          executionId: "execution",
          subcallId: "one",
          operation: "app.tasks.get",
          input: {},
          status: "completed",
          result: { id: "T-20260908-0004" },
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(2).toISOString(),
          durationMs: 2,
          links,
        },
        {
          executionId: "execution",
          subcallId: "two",
          operation: "app.admin.delete",
          input: {},
          status: "failed",
          error: "forbidden",
          startedAt: new Date(2).toISOString(),
          completedAt: new Date(3).toISOString(),
          durationMs: 1,
        },
      ],
    });

    expect(presentation.partial).toBe(true);
    expect(presentation.links).toEqual(expect.arrayContaining([
      { label: "T-20260908-0004", href: "/tasks/T-20260908-0004" },
      { label: "https://github.com/acme/repo/pull/7", href: "https://github.com/acme/repo/pull/7" },
    ]));
  });
});
