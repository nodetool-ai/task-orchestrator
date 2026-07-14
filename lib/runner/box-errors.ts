// lib/runner/box-errors.ts
// Pure normalization for Box SDK failures. Providers consume the stable result
// instead of depending on generated SDK errors or logging their raw payloads.

import { FetchError, ResponseError } from "@asciidev/box-sdk";

export type BoxErrorCategory =
  | "unauthorized"
  | "billing-required"
  | "capacity"
  | "rate-limited"
  | "not-found"
  | "conflict"
  | "transient"
  | "invalid-request"
  | "unknown";

export interface BoxApiError {
  category: BoxErrorCategory;
  /** HTTP status when Box supplied one. */
  status?: number;
  /** Stable Box error code, with any sensitive content redacted. */
  code?: string;
  /** Safe-to-log error text, never a raw SDK payload. */
  message: string;
  /** Box request identifier, with any sensitive content redacted. */
  requestId?: string;
}

interface BoxErrorFields {
  status?: number;
  code?: string;
  message?: string;
  requestId?: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function status(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Redact rather than attempt to selectively preserve URLs or credential-like
 * values. This is intentionally conservative because this data is intended for
 * telemetry and operator logs, not user display.
 */
export function redactBoxErrorText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=:-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*([:=])\s*[^\s,;"']+/gi,
      "$1$2[redacted]"
    );
}

function normalizedText(value: unknown): string | undefined {
  const text = string(value);
  return text ? redactBoxErrorText(text) : undefined;
}

function isCapacityCodeOrMessage(code: string | undefined, message: string | undefined): boolean {
  const detail = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return /\b(capacity|active[_ -]?boxes?|max[_ -]?active|box[_ -]?limit|quota)\b/.test(detail);
}

/** Pure status/code classification used both by SDK normalization and tests. */
export function classifyBoxError(fields: Pick<BoxErrorFields, "status" | "code" | "message">): BoxErrorCategory {
  const { status: httpStatus, code, message } = fields;
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 402) return "billing-required";
  if (httpStatus === 404) return "not-found";
  if (httpStatus === 409) return "conflict";
  if (httpStatus === 429) return isCapacityCodeOrMessage(code, message) ? "capacity" : "rate-limited";
  if (httpStatus === 408 || httpStatus === 425 || httpStatus === 0 || (httpStatus != null && httpStatus >= 500)) {
    return "transient";
  }
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 500) return "invalid-request";
  return "unknown";
}

function normalizeFields(fields: BoxErrorFields, fallback = "Box API request failed"): BoxApiError {
  const code = normalizedText(fields.code);
  const message = normalizedText(fields.message) ?? fallback;
  const requestId = normalizedText(fields.requestId);
  return {
    category: classifyBoxError({ status: fields.status, code, message }),
    ...(fields.status != null ? { status: fields.status } : {}),
    ...(code ? { code } : {}),
    message,
    ...(requestId ? { requestId } : {}),
  };
}

async function fieldsFromResponse(response: Response): Promise<BoxErrorFields> {
  const headerRequestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  let body: UnknownRecord = {};
  try {
    body = record(await response.clone().json());
  } catch {
    // Some upstream/proxy responses are text or HTML. Do not retain the raw
    // body; it can contain a URL or echoed authorization data.
  }
  const nested = record(body.error);
  return {
    // The transport status is authoritative; an envelope is untrusted error
    // content and must not be able to reclassify a 401 as a transient 5xx.
    status: response.status || status(body.status),
    code: string(body.code) ?? string(nested.code),
    message: string(body.message) ?? string(nested.message),
    requestId: string(body.requestId) ?? headerRequestId,
  };
}

function responseFromUnknown(error: unknown): Response | undefined {
  if (error instanceof ResponseError) return error.response;
  const candidate = record(error).response;
  return candidate instanceof Response ? candidate : undefined;
}

/**
 * Normalize an SDK or arbitrary thrown error. Reading an SDK response is the
 * only asynchronous step; this function has no I/O beyond that already-held
 * response body and performs no logging or provider lifecycle work.
 */
export async function normalizeBoxApiError(error: unknown): Promise<BoxApiError> {
  const response = responseFromUnknown(error);
  if (response) return normalizeFields(await fieldsFromResponse(response));

  if (error instanceof FetchError) {
    return normalizeFields({ status: 0, message: error.message }, "Box API network request failed");
  }
  if (error instanceof Error) return normalizeFields({ message: error.message }, "Box API request failed");
  return normalizeFields({}, "Unknown Box API error");
}

/** A deliberately narrow representation suitable for structured logging. */
export function serializeBoxApiError(error: BoxApiError): BoxApiError {
  return normalizeFields(error, "Box API request failed");
}
