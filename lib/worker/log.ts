// lib/worker/log.ts
//
// Structured, leveled logging for the worker ⇄ server protocol surfaces (the
// worker entrypoint and the control-plane RunTransport implementation). One line
// per entry so `docker logs` / `fly logs` / journald stay
// grep-able; TASK_ORCH_LOG_FORMAT=json switches to JSON lines for ingestion
// into a log pipeline.
//
//   TASK_ORCH_LOG_LEVEL:  debug | info | warn | error   (default: info)
//   TASK_ORCH_LOG_FORMAT: text | json                   (default: text)
//
// Env is read per-call (not memoized) so tests and long-lived processes can
// flip verbosity without a restart.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger with extra fields bound to every entry (e.g. { runId }). */
  child(fields: LogFields): Logger;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = (process.env.TASK_ORCH_LOG_LEVEL ?? "").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

function jsonFormat(): boolean {
  return (process.env.TASK_ORCH_LOG_FORMAT ?? "").toLowerCase() === "json";
}

/** Render a field value for the text format: primitives bare, the rest JSON. */
function renderValue(v: unknown): string {
  if (v instanceof Error) return JSON.stringify(v.message);
  if (typeof v === "string") return /[\s="]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean" || v == null) return String(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** JSON.stringify replacement for field values the JSON format can't carry. */
function jsonSafeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) out[k] = { message: v.message, stack: v.stack };
    else if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

function emit(component: string, level: LogLevel, msg: string, fields: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[configuredLevel()]) return;
  const ts = new Date().toISOString();
  // warn/error → stderr so container log demuxers keep severity; rest → stdout.
  const sink = level === "warn" || level === "error" ? console.error : console.log;
  if (jsonFormat()) {
    sink(JSON.stringify({ ts, level, component, msg, ...jsonSafeFields(fields) }));
    return;
  }
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${renderValue(v)}`)
    .join(" ");
  sink(`${ts} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${pairs ? " " + pairs : ""}`);
}

export function createLogger(component: string, base: LogFields = {}): Logger {
  const log = (level: LogLevel) => (msg: string, fields?: LogFields) =>
    emit(component, level, msg, { ...base, ...(fields ?? {}) });
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    child: (fields: LogFields) => createLogger(component, { ...base, ...fields }),
  };
}
