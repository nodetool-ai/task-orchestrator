import { describe, expect, it } from "vitest";
import {
  executeCodeAct,
  MemoryCodeActReceiptStore,
} from "../lib/codeact/bridge";
import type { AppApiContext } from "../lib/app-api/types";

const context = {} as AppApiContext;

describe("CodeAct execution bridge", () => {
  it("returns bounded structured output and persists the terminal receipt", async () => {
    const receipts = new MemoryCodeActReceiptStore();
    const result = await executeCodeAct({
      code: "console.log('diagnostic'); output.text({ answer: 42 }); return { ok: true };",
      context,
      receipts,
    });

    expect(result.receipt.status).toBe("completed");
    expect(result.receipt.outputs).toEqual([{ kind: "text", value: { answer: 42 } }]);
    expect(result.receipt.diagnostics).toEqual([{ level: "log", values: ["diagnostic"] }]);
    expect(receipts.executions.get(result.executionId)).toMatchObject({ status: "completed" });
  });

  it("does not start guest work for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeCodeAct({ code: "while (true) {}", context, signal: controller.signal });

    expect(result.receipt.status).toBe("cancelled");
    expect(result.status).toBe("terminated");
  });
});
