import { createHash, randomUUID } from "node:crypto";
import { dispatchAppOperation } from "../app-api";
import type { AppApiContext } from "../app-api/types";
import { codeActCatalog } from "./catalog";
import { executeInThread, type ThreadResult } from "./thread";
import { resolveLimits, type ExecutionLimits } from "./limits";
import { boundedText, normalizeOutput, type CodeActOutput } from "./output";

export interface CodeActSubcallReceipt { executionId: string; subcallId: string; operation: string; input: unknown; status: "running" | "completed" | "failed" | "cancelled" | "unknown"; result?: unknown; error?: string }
export interface CodeActExecutionReceipt { executionId: string; sourceSha256: string; status: "running" | "completed" | "failed" | "cancelled" | "deadline" | "unknown"; subcalls: CodeActSubcallReceipt[]; outputs: CodeActOutput[]; diagnostics: Array<{ level: string; values: unknown[] }> }

export interface CodeActReceiptStore {
  begin(receipt: CodeActExecutionReceipt): Promise<void>;
  subcall(receipt: CodeActSubcallReceipt): Promise<void>;
  finish(executionId: string, patch: Partial<CodeActExecutionReceipt>): Promise<void>;
}

export interface CodeActExecuteRequest {
  code: string;
  title?: string;
  context: AppApiContext;
  limits?: Partial<ExecutionLimits>;
  signal?: AbortSignal;
  receipts?: CodeActReceiptStore;
}

export type CodeActExecuteResult = ThreadResult & { executionId: string; receipt: CodeActExecutionReceipt };

export async function executeCodeAct(request: CodeActExecuteRequest): Promise<CodeActExecuteResult> {
  const limits = resolveLimits(request.limits);
  const executionId = randomUUID();
  const receipt: CodeActExecutionReceipt = {
    executionId,
    sourceSha256: createHash("sha256").update(request.code).digest("hex"),
    status: "running", subcalls: [], outputs: [], diagnostics: [],
  };
  await request.receipts?.begin(receipt);
  let cancelled = false;
  let closed = false;
  const durability: Promise<void>[] = [];
  const abort = () => { cancelled = true; };
  request.signal?.addEventListener("abort", abort, { once: true });
  const persistSubcall = (subcall: CodeActSubcallReceipt) => {
    const write = request.receipts?.subcall(subcall) ?? Promise.resolve();
    durability.push(write);
    return write;
  };
  const cancelRunning = () => {
    for (const subcall of receipt.subcalls) {
      if (subcall.status !== "running") continue;
      subcall.status = "cancelled";
      subcall.error = "execution cancelled before the host outcome was durable";
      void persistSubcall(subcall);
    }
  };
  const closeRunning = (status: "cancelled" | "unknown", message: string) => {
    for (const subcall of receipt.subcalls) {
      if (subcall.status !== "running") continue;
      subcall.status = status;
      subcall.error = message;
      void persistSubcall(subcall);
    }
  };
  if (request.signal?.aborted) {
    cancelled = true;
    cancelRunning();
  }
  const hostCall = async (operation: string, input: unknown): Promise<unknown> => {
    if (cancelled) throw new Error("CodeAct execution cancelled");
    const subcallId = randomUUID();
    const subcall: CodeActSubcallReceipt = { executionId, subcallId, operation, input, status: "running" };
    receipt.subcalls.push(subcall);
    await persistSubcall(subcall);
    // Cancellation can race the durable reservation above. Never dispatch an
    // operation after cancellation, even if the guest had already submitted it.
    if (cancelled || closed) {
      subcall.status = "cancelled";
      subcall.error = "execution cancelled before dispatch";
      await persistSubcall(subcall);
      throw new Error("CodeAct execution cancelled");
    }
    try {
      if (operation === "output.text" || operation === "output.image") return input;
      const result = await dispatchAppOperation(operation.replace(/^(app|tools)\./, ""), input, { ...request.context, executionId, subcallId } as AppApiContext & { executionId: string; subcallId: string });
      if (closed || cancelled) return result;
      subcall.status = "completed"; subcall.result = normalizeOutput(result, limits.maxOutputBytes);
      await persistSubcall(subcall);
      return result;
    } catch (error) {
      if (closed) throw error;
      subcall.status = cancelled ? "cancelled" : "failed";
      subcall.error = boundedText(error instanceof Error ? error.message : String(error), 4096);
      await persistSubcall(subcall);
      throw error;
    }
  };
  const result = await executeInThread({ code: request.code, limits, catalog: codeActCatalog(request.context.capabilities), hostCall, signal: request.signal });
  closed = true;
  if (cancelled) cancelRunning();
  else if (result.status !== "ok") closeRunning("unknown", "execution ended before the host outcome was durable");
  else closeRunning("unknown", "guest completed with unawaited host work");
  await Promise.all(durability);
  receipt.outputs = (("outputs" in result ? result.outputs : undefined) ?? []).map((x) => ({ kind: x.kind, value: normalizeOutput(x.value, limits.maxOutputBytes) }));
  receipt.diagnostics = (("diagnostics" in result ? result.diagnostics : undefined) ?? []).map((x) => ({ level: x.level, values: x.values.map((v) => normalizeOutput(v, limits.maxOutputBytes)) }));
  receipt.status = cancelled ? "cancelled" : result.status === "terminated" ? "deadline" : result.status === "ok" ? "completed" : result.status === "timeout" ? "deadline" : "failed";
  await request.receipts?.finish(executionId, receipt);
  request.signal?.removeEventListener("abort", abort);
  return { ...result, executionId, receipt };
}

/** Crash recovery is deliberately reconciliation-only: a persisted running
 * subcall becomes unknown and is never used to replay the guest program. */
export async function recoverCodeActExecution(
  receipt: CodeActExecutionReceipt,
  store?: CodeActReceiptStore,
): Promise<CodeActExecutionReceipt> {
  for (const subcall of receipt.subcalls) {
    if (subcall.status === "running") { subcall.status = "unknown"; subcall.error = "execution ended before the host outcome was durable"; await store?.subcall(subcall); }
  }
  receipt.status = receipt.status === "running" ? "unknown" : receipt.status;
  await store?.finish(receipt.executionId, receipt);
  return receipt;
}

export class MemoryCodeActReceiptStore implements CodeActReceiptStore {
  readonly executions = new Map<string, CodeActExecutionReceipt>();
  async begin(receipt: CodeActExecutionReceipt) { this.executions.set(receipt.executionId, structuredClone(receipt)); }
  async subcall(receipt: CodeActSubcallReceipt) { for (const execution of this.executions.values()) { const found = execution.subcalls.find((x) => x.subcallId === receipt.subcallId); if (found) Object.assign(found, structuredClone(receipt)); else if (execution.status === "running") execution.subcalls.push(structuredClone(receipt)); } }
  async finish(executionId: string, patch: Partial<CodeActExecutionReceipt>) { const current = this.executions.get(executionId); if (current) Object.assign(current, structuredClone(patch)); }
}
