import type { CodeActExecutionReceipt, CodeActLink, CodeActSubcallReceipt } from "./bridge";
import { boundedText, normalizeOutput } from "./output";

export const CODEACT_PRESENTATION_RESULT_BYTES = 4 * 1024;
export const CODEACT_MODEL_RESULT_BYTES = 64 * 1024;

export interface CodeActPresentationSubcall {
  operation: string;
  status: CodeActSubcallReceipt["status"];
  durationMs?: number;
  result?: unknown;
  error?: string;
  links: CodeActLink[];
}

export interface CodeActPresentation {
  executionId: string;
  title?: string;
  source: string;
  error?: CodeActExecutionReceipt["error"];
  status: CodeActExecutionReceipt["status"];
  durationMs?: number;
  result?: unknown;
  outputs: CodeActExecutionReceipt["outputs"];
  diagnostics: CodeActExecutionReceipt["diagnostics"];
  subcalls: CodeActPresentationSubcall[];
  links: CodeActLink[];
  partial: boolean;
}

export function presentCodeActReceipt(receipt: CodeActExecutionReceipt): CodeActPresentation {
  const subcalls = receipt.subcalls.map((subcall) => ({
    operation: subcall.operation,
    status: subcall.status,
    durationMs: subcall.durationMs,
    ...(subcall.result === undefined
      ? {}
      : { result: normalizeOutput(subcall.result, CODEACT_PRESENTATION_RESULT_BYTES) }),
    ...(subcall.error ? { error: boundedText(subcall.error, CODEACT_PRESENTATION_RESULT_BYTES) } : {}),
    links: subcall.links ?? [],
  }));
  const completed = subcalls.filter((subcall) => subcall.status === "completed").length;
  const incomplete = subcalls.length - completed;
  return {
    executionId: receipt.executionId,
    ...(receipt.title ? { title: receipt.title } : {}),
    source: receipt.source,
    ...(receipt.error ? { error: receipt.error } : {}),
    status: receipt.status,
    durationMs: receipt.durationMs,
    ...(receipt.result === undefined
      ? {}
      : { result: normalizeOutput(receipt.result, CODEACT_PRESENTATION_RESULT_BYTES) }),
    outputs: receipt.outputs.map((output) => ({
      ...output,
      value: normalizeOutput(output.value, CODEACT_PRESENTATION_RESULT_BYTES),
    })),
    diagnostics: receipt.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      values: diagnostic.values.map((value) =>
        normalizeOutput(value, CODEACT_PRESENTATION_RESULT_BYTES),
      ),
    })),
    subcalls,
    links: receipt.links ?? [],
    partial: completed > 0 && incomplete > 0,
  };
}

/** The model sees a bounded summary; the richer structured presentation rides
 * on the same content block for transcript clients. */
export function codeActModelText(presentation: CodeActPresentation): string {
  return boundedText(
    {
      executionId: presentation.executionId,
      status: presentation.status,
      error: presentation.error,
      partial: presentation.partial,
      durationMs: presentation.durationMs,
      result: presentation.result,
      outputs: presentation.outputs,
      diagnostics: presentation.diagnostics,
      subcalls: presentation.subcalls,
    },
    CODEACT_MODEL_RESULT_BYTES,
  );
}

export function isCodeActPresentation(value: unknown): value is CodeActPresentation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodeActPresentation>;
  return (
    typeof candidate.executionId === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.subcalls) &&
    Array.isArray(candidate.outputs) &&
    Array.isArray(candidate.diagnostics) &&
    Array.isArray(candidate.links)
  );
}
