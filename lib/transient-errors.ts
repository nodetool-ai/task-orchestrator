// Classify transient network / DB connection errors that must not crash a
// long-lived worker.
//
// A detached runner talks to Postgres over flycast for LISTEN/NOTIFY and
// best-effort log flushing. When that connection is reset (flycast blip, idle
// socket dropped, DB recycling a backend) the socket error arrives as an
// *unhandled rejection* from a promise nobody is awaiting — Node's default
// `--unhandled-rejections=throw` then escalates it to an uncaught exception and
// kills the process, failing an otherwise-healthy run. These errors are not
// about the run's actual work (that is awaited and handled by the caller), so a
// transient one should be swallowed, not fatal.

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  // postgres.js connection-lifecycle codes
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

const TRANSIENT_MESSAGE_RE =
  /ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|socket hang up|CONNECTION_CLOSED|CONNECTION_ENDED|Connection terminated/i;

/**
 * True when `err` (or anything in its cause/errors chain) is a transient
 * network / DB connection reset rather than an application-level failure.
 */
export function isTransientNetworkError(err: unknown): boolean {
  // Iterative traversal over the .cause chain and .errors fan-out, with a single
  // shared `seen` set so a cyclic graph (e.g. err.errors = [err]) terminates
  // instead of overflowing the stack — important since this runs while handling
  // an already-problematic process event.
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);

    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    const message = (cur as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_MESSAGE_RE.test(message)) {
      return true;
    }

    const cause = (cur as { cause?: unknown }).cause;
    if (cause) stack.push(cause);
    // postgres.js / AggregateError bundle sub-errors under `.errors`
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors)) stack.push(...errors);
  }
  return false;
}

export interface SafetyNetOptions {
  /** Prefix for log lines. */
  label?: string;
  /** Injectable logger (tests). Defaults to `console`. */
  logger?: Pick<Console, "error" | "warn">;
  /** Called for genuinely fatal errors. Defaults to `process.exit(1)`. */
  onFatal?: (err: unknown) => void;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return `${err.name}: ${err.message}${code ? ` (${String(code)})` : ""}`;
  }
  return String(err);
}

/**
 * Install process-level handlers that swallow transient network/DB connection
 * errors (which surface as unhandled rejections from detached sockets) instead
 * of letting Node crash. Genuinely fatal errors still log and go to `onFatal`
 * (default `process.exit(1)`), preserving fail-fast behaviour for real bugs.
 *
 * Returns a disposer that removes the handlers.
 */
export function installProcessSafetyNet(opts: SafetyNetOptions = {}): () => void {
  const log = opts.logger ?? console;
  const label = opts.label ?? "safety-net";
  const onFatal = opts.onFatal ?? ((): void => void process.exit(1));

  const handle = (kind: string, err: unknown): void => {
    if (isTransientNetworkError(err)) {
      log.warn(`[${label}] swallowed transient ${kind}: ${describe(err)}`);
      return;
    }
    log.error(`[${label}] fatal ${kind}:`, err);
    onFatal(err);
  };

  const onRejection = (reason: unknown): void =>
    handle("unhandled rejection", reason);
  const onException = (err: unknown): void =>
    handle("uncaught exception", err);

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
