"use client";

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";

/**
 * App Router error boundary. Catches errors thrown during rendering — including
 * rejected fetches surfaced from async transitions in client components (e.g.
 * the local orchestrator restarting → ERR_CONNECTION_REFUSED) — and renders a
 * friendly inline fallback with a Retry button instead of crashing the whole
 * route to Next's generic error screen.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error for debugging; the UI stays intentionally terse.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 pt-24 text-center">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Something went wrong
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          An unexpected error occurred. The page may have lost connection to the
          orchestrator. You can retry — your data is safe.
        </p>
        {error.message && (
          <p className="mt-2 break-words font-mono text-[11px] text-state-blocked">
            {error.message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => reset()}
        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90"
      >
        <RotateCcw className="size-3.5" />
        Retry
      </button>
    </div>
  );
}
