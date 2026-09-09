import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentSessions, codeactExecutions, codeactSubcalls } from "../db/schema";
import { PostgresCodeActReceiptStore, recoverOrphanedCodeActExecutions } from "../lib/codeact/receipts";
import { executeCodeAct, type CodeActExecutionReceipt } from "../lib/codeact/bridge";

async function fixture() {
  const [run] = await db.insert(agentSessions).values({ goal: "<chat>" }).returning();
  const receipt: CodeActExecutionReceipt = {
    executionId: randomUUID(), source: "must never replay", sourceSha256: "hash",
    status: "running", subcalls: [], outputs: [], diagnostics: [], startedAt: new Date().toISOString(),
  };
  return { receipt, store: new PostgresCodeActReceiptStore(run.id) };
}

describe("CodeAct durable recovery", () => {
  it("skips a live owner, then reconstructs subcalls after ownership is lost", async () => {
    const { receipt, store } = await fixture();
    const completedId = randomUUID();
    const runningId = randomUUID();
    await expect(store.withOwnership(receipt.executionId, async () => {
      await store.begin(receipt);
      for (const [subcallId, status] of [[completedId, "completed"], [runningId, "running"]] as const) {
        await store.subcall({
          executionId: receipt.executionId, subcallId, operation: "app.tasks.create", input: { title: "retained" },
          status, startedAt: receipt.startedAt,
          ...(status === "completed" ? { result: { id: "T-20260908-0004" } } : {}),
        });
      }
      // A different connection/process must not steal this execution.
      expect(await recoverOrphanedCodeActExecutions()).toBe(0);
      throw new Error("owner lost before finish");
    })).rejects.toThrow("owner lost");

    const outcomes = await Promise.all([recoverOrphanedCodeActExecutions(), recoverOrphanedCodeActExecutions()]);
    expect(outcomes.reduce((a, b) => a + b, 0)).toBe(1);
    const [saved] = await db.select().from(codeactExecutions).where(eq(codeactExecutions.executionId, receipt.executionId));
    expect(saved.status).toBe("unknown");
    const recovered = saved.receipt as CodeActExecutionReceipt;
    expect(recovered.subcalls).toHaveLength(2);
    expect(recovered.subcalls.find((call) => call.subcallId === completedId)).toMatchObject({ status: "completed", result: { id: "T-20260908-0004" } });
    expect(recovered.subcalls.find((call) => call.subcallId === runningId)).toMatchObject({ status: "unknown", input: { title: "retained" } });
    const [subcall] = await db.select().from(codeactSubcalls).where(eq(codeactSubcalls.subcallId, runningId));
    expect(subcall.status).toBe("unknown");
    expect(await recoverOrphanedCodeActExecutions()).toBe(0);
  });

  it("keeps completed executions and persisted guest errors terminal", async () => {
    const { store } = await fixture();
    const result = await executeCodeAct({ code: 'throw new Error("persist me")', receipts: store });
    expect(await recoverOrphanedCodeActExecutions()).toBe(0);
    const [saved] = await db.select().from(codeactExecutions).where(eq(codeactExecutions.executionId, result.executionId));
    expect(saved.status).toBe("failed");
    expect(saved.receipt).toMatchObject({ error: { name: "Error", message: "persist me" } });
  });
});
