import { createHash, randomUUID } from "node:crypto";
import { executeInThread, type ThreadResult } from "./thread";
import { resolveLimits, type ExecutionLimits } from "./limits";
import { boundedText, normalizeOutput, type CodeActOutput } from "./output";

export interface CodeActLink { label: string; href: string }
export interface CodeActSubcallReceipt {
  executionId: string;
  subcallId: string;
  operation: string;
  input: unknown;
  status: "running" | "completed" | "failed" | "cancelled" | "unknown";
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  links?: CodeActLink[];
}
export interface CodeActExecutionReceipt {
  executionId: string;
  title?: string;
  source: string;
  sourceSha256: string;
  status: "running" | "completed" | "failed" | "cancelled" | "deadline" | "unknown";
  result?: unknown;
  subcalls: CodeActSubcallReceipt[];
  outputs: CodeActOutput[];
  diagnostics: Array<{ level: string; values: unknown[] }>;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  links?: CodeActLink[];
}

export interface CodeActReceiptStore {
  begin(receipt: CodeActExecutionReceipt): Promise<void>;
  subcall(receipt: CodeActSubcallReceipt): Promise<void>;
  finish(executionId: string, patch: Partial<CodeActExecutionReceipt>): Promise<void>;
}

export interface CodeActExecuteRequest {
  code: string;
  title?: string;
  /**
   * Host-owned catalogue embedded into the guest. Keeping this injectable is
   * what lets worker backends expose their already-authorized neutral tools
   * without importing the control-plane operation registry (and its database
   * dependencies) into the worker bundle.
   */
  catalog?: unknown;
  /** Dispatch one resolved guest operation. The host generates both receipt
   * ids; guest source can never select or reuse them. */
  dispatch?: (
    operation: string,
    input: unknown,
    metadata: { executionId: string; subcallId: string },
  ) => Promise<unknown>;
  limits?: Partial<ExecutionLimits>;
  signal?: AbortSignal;
  receipts?: CodeActReceiptStore;
}

export type CodeActExecuteResult = ThreadResult & { executionId: string; receipt: CodeActExecutionReceipt };

export async function executeCodeAct(request: CodeActExecuteRequest): Promise<CodeActExecuteResult> {
  const limits = resolveLimits(request.limits);
  const executionId = randomUUID();
  const startedAtMs = Date.now();
  const receipt: CodeActExecutionReceipt = {
    executionId,
    ...(request.title ? { title: boundedText(request.title, 512) } : {}),
    source: boundedText(request.code, limits.sourceBytes),
    sourceSha256: createHash("sha256").update(request.code).digest("hex"),
    status: "running", subcalls: [], outputs: [], diagnostics: [],
    startedAt: new Date(startedAtMs).toISOString(),
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
      subcall.completedAt = new Date().toISOString();
      subcall.durationMs = Math.max(0, Date.now() - Date.parse(subcall.startedAt));
      void persistSubcall(subcall);
    }
  };
  const closeRunning = (status: "cancelled" | "unknown", message: string) => {
    for (const subcall of receipt.subcalls) {
      if (subcall.status !== "running") continue;
      subcall.status = status;
      subcall.error = message;
      subcall.completedAt = new Date().toISOString();
      subcall.durationMs = Math.max(0, Date.now() - Date.parse(subcall.startedAt));
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
    const subcallStartedMs = Date.now();
    const subcall: CodeActSubcallReceipt = {
      executionId,
      subcallId,
      operation,
      input: normalizeOutput(input, limits.maxOutputBytes),
      status: "running",
      startedAt: new Date(subcallStartedMs).toISOString(),
    };
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
      if (!request.dispatch) throw new Error(`No host dispatcher is available for CodeAct operation '${operation}'.`);
      const result = await request.dispatch(operation, input, { executionId, subcallId });
      if (closed || cancelled) return result;
      subcall.status = "completed";
      subcall.result = normalizeOutput(result, limits.maxOutputBytes);
      subcall.completedAt = new Date().toISOString();
      subcall.durationMs = Date.now() - subcallStartedMs;
      subcall.links = extractCodeActLinks(subcall.result);
      await persistSubcall(subcall);
      return result;
    } catch (error) {
      if (closed) throw error;
      subcall.status = cancelled ? "cancelled" : "failed";
      subcall.error = boundedText(error instanceof Error ? error.message : String(error), 4096);
      subcall.completedAt = new Date().toISOString();
      subcall.durationMs = Date.now() - subcallStartedMs;
      await persistSubcall(subcall);
      throw error;
    }
  };
  const result = await executeInThread({
    code: request.code,
    limits,
    catalog: request.catalog,
    hostCall,
    signal: request.signal,
  });
  closed = true;
  if (cancelled) cancelRunning();
  else if (result.status !== "ok") closeRunning("unknown", "execution ended before the host outcome was durable");
  else closeRunning("unknown", "guest completed with unawaited host work");
  await Promise.all(durability);
  receipt.outputs = (("outputs" in result ? result.outputs : undefined) ?? []).map((x) => ({ kind: x.kind, value: normalizeOutput(x.value, limits.maxOutputBytes) }));
  receipt.diagnostics = (("diagnostics" in result ? result.diagnostics : undefined) ?? []).map((x) => ({ level: x.level, values: x.values.map((v) => normalizeOutput(v, limits.maxOutputBytes)) }));
  if ("value" in result) receipt.result = normalizeOutput(result.value, limits.maxOutputBytes);
  receipt.status = cancelled ? "cancelled" : result.status === "terminated" ? "deadline" : result.status === "ok" ? "completed" : result.status === "timeout" ? "deadline" : "failed";
  receipt.completedAt = new Date().toISOString();
  receipt.durationMs = Date.now() - startedAtMs;
  receipt.links = extractCodeActLinks({
    result: receipt.result,
    outputs: receipt.outputs,
    subcalls: receipt.subcalls.flatMap((subcall) => subcall.links ?? []),
  });
  await request.receipts?.finish(executionId, receipt);
  request.signal?.removeEventListener("abort", abort);
  return { ...result, executionId, receipt };
}

const ENTITY_PATHS: Array<[RegExp, (id: string) => string]> = [
  [/^T-\d{8}-\d{4}$/, (id) => `/tasks/${id}`],
  [/^P-\d{4}-\d{2}-\d{2}-.+$/, (id) => `/plans/${id}`],
];

/** Extract a small, deduplicated set of navigable entities from bounded
 * operation results. JSON-looking text blocks are inspected structurally. */
export function extractCodeActLinks(value: unknown, limit = 20): CodeActLink[] {
  const links = new Map<string, CodeActLink>();
  const add = (label: string, href: string) => {
    if (links.size >= limit || links.has(href)) return;
    links.set(href, { label, href });
  };
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 8 || links.size >= limit || candidate == null) return;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      for (const [pattern, pathFor] of ENTITY_PATHS) {
        if (pattern.test(trimmed)) add(trimmed, pathFor(trimmed));
      }
      for (const match of trimmed.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
        add(match[0], match[0]);
      }
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 256 * 1024) {
        try { visit(JSON.parse(trimmed), depth + 1); } catch { /* ordinary text */ }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (typeof candidate === "object") {
      for (const item of Object.values(candidate as Record<string, unknown>)) {
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return [...links.values()];
}

/** Crash recovery is deliberately reconciliation-only: a persisted running
 * subcall becomes unknown and is never used to replay the guest program. */
export async function recoverCodeActExecution(
  receipt: CodeActExecutionReceipt,
  store?: CodeActReceiptStore,
): Promise<CodeActExecutionReceipt> {
  for (const subcall of receipt.subcalls) {
    if (subcall.status === "running") {
      subcall.status = "unknown";
      subcall.error = "execution ended before the host outcome was durable";
      subcall.completedAt = new Date().toISOString();
      subcall.durationMs = Math.max(0, Date.now() - Date.parse(subcall.startedAt));
      await store?.subcall(subcall);
    }
  }
  receipt.status = receipt.status === "running" ? "unknown" : receipt.status;
  receipt.completedAt ??= new Date().toISOString();
  receipt.durationMs ??= Math.max(0, Date.now() - Date.parse(receipt.startedAt));
  await store?.finish(receipt.executionId, receipt);
  return receipt;
}

export class MemoryCodeActReceiptStore implements CodeActReceiptStore {
  readonly executions = new Map<string, CodeActExecutionReceipt>();
  async begin(receipt: CodeActExecutionReceipt) { this.executions.set(receipt.executionId, structuredClone(receipt)); }
  async subcall(receipt: CodeActSubcallReceipt) { for (const execution of this.executions.values()) { const found = execution.subcalls.find((x) => x.subcallId === receipt.subcallId); if (found) Object.assign(found, structuredClone(receipt)); else if (execution.status === "running") execution.subcalls.push(structuredClone(receipt)); } }
  async finish(executionId: string, patch: Partial<CodeActExecutionReceipt>) { const current = this.executions.get(executionId); if (current) Object.assign(current, structuredClone(patch)); }
}
