import { randomUUID } from "node:crypto";
import type { BackendDiagnostics, RunTurnArgs } from "./types";

/** Never let a diagnostics implementation affect the run.  This is kept in a
 * separate helper so every adapter has identical failure semantics. */
export function diagnosticEmit(
  sink: BackendDiagnostics | undefined,
  event: string,
  attributes: Record<string, unknown> = {},
): void {
  try { sink?.emit(event, attributes); } catch { /* diagnostics are best effort */ }
}

export interface BackendInvocation {
  readonly id: string;
  readonly diagnostics?: BackendDiagnostics;
  emit(event: string, attributes?: Record<string, unknown>): void;
  toolStarted(toolName: string, sdkItemId: string): void;
  toolFinished(toolName: string, sdkItemId: string, outcome: string, startedAt: number): void;
  finish(outcome: string, error?: unknown): void;
}

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function errorCategory(error: unknown, aborted: boolean): string {
  if (aborted) return "aborted";
  if (error instanceof Error && /(?:cancel|abort)/i.test(error.message)) return "cancelled";
  return "error";
}

function abortCategory(reason: unknown): string {
  // Signal reasons can contain provider errors, command text, or other
  // sensitive payloads. Keep only a small categorical value in diagnostics.
  if (reason instanceof Error && /stalled|watchdog|idle timeout/i.test(reason.message)) return "watchdog";
  if (reason instanceof Error && /deadline|wall.?clock|budget/i.test(reason.message)) return "deadline";
  if (reason instanceof Error && /cancel/i.test(reason.message)) return "cancelled";
  return "aborted";
}

function diagnosticSnapshot(sink: BackendDiagnostics | undefined): Record<string, unknown> {
  try { return sink?.snapshot?.() ?? {}; } catch { return {}; }
}

/** Start one fresh invocation identity and report its terminal state exactly
 * once. The abort listener is intentionally synchronous; settlement is emitted
 * by finish() when the adapter's promise actually settles (which may be after
 * the watchdog has returned). */
export function beginBackendInvocation(args: RunTurnArgs): BackendInvocation {
  const id = randomUUID();
  const sink = args.diagnostics;
  const startedAt = monotonicNow();
  let abortAt: number | undefined;
  let finished = false;
  let abortRequested = false;

  const context = {
    invocation_id: id,
    model: args.model.id,
    "model.provider": args.model.provider,
    ...(args.diagnosticsContext ?? {}),
    ...diagnosticSnapshot(args.diagnostics),
  };
  diagnosticEmit(sink, "backend.started", context);

  const onAbort = () => {
    if (abortRequested) return;
    abortRequested = true;
    abortAt = monotonicNow();
    diagnosticEmit(sink, "backend.abort_requested", {
      invocation_id: id,
      reason: abortCategory(args.abort.signal.reason),
    });
  };
  args.abort.signal.addEventListener("abort", onAbort, { once: true });
  if (args.abort.signal.aborted) onAbort();

  return {
    id,
    diagnostics: sink,
    emit(event, attrs = {}) {
      diagnosticEmit(sink, event, { invocation_id: id, ...attrs });
    },
    toolStarted(toolName, sdkItemId) {
      diagnosticEmit(sink, "tool.started", {
        invocation_id: id,
        "tool.name": toolName.slice(0, 200),
        "tool.item_id": sdkItemId.slice(0, 200),
      });
    },
    toolFinished(toolName, sdkItemId, outcome, toolStartedAt) {
      diagnosticEmit(sink, "tool.finished", {
        invocation_id: id,
        "tool.name": toolName.slice(0, 200),
        "tool.item_id": sdkItemId.slice(0, 200),
        "tool.outcome": outcome.slice(0, 80),
        "tool.duration_ms": Math.max(0, monotonicNow() - toolStartedAt),
      });
    },
    finish(outcome, error) {
      if (finished) return;
      finished = true;
      args.abort.signal.removeEventListener("abort", onAbort);
      diagnosticEmit(sink, "backend.finished", {
        invocation_id: id,
        outcome: abortRequested ? errorCategory(error, true) : outcome.slice(0, 80),
        duration_ms: Math.max(0, monotonicNow() - startedAt),
      });
      if (abortAt !== undefined) {
        diagnosticEmit(sink, "backend.abort_settled", {
          invocation_id: id,
          settlement_delay_ms: Math.max(0, monotonicNow() - abortAt),
          outcome: outcome.slice(0, 80),
        });
      }
    },
  };
}

/** Convenience wrapper for small adapter tests and future adapters. Existing
 * adapters use beginBackendInvocation directly because they need the identity
 * while wiring provider-specific tool callbacks. */
export async function withBackendInvocation<T>(
  args: RunTurnArgs,
  operation: (invocation: BackendInvocation) => Promise<T>,
): Promise<T> {
  const invocation = beginBackendInvocation(args);
  try {
    const result = await operation(invocation);
    invocation.finish("completed");
    return result;
  } catch (error) {
    invocation.finish(args.abort.signal.aborted ? "aborted" : "error", error);
    throw error;
  }
}

export function markTranscriptOutput(sink: BackendDiagnostics | undefined): void {
  try { sink?.transcriptOutput?.(); } catch { /* best effort */ }
}
