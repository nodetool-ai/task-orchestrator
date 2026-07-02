// One-shot handoff of a chat's first message from the /chat composer
// (NewChatBox) to the conversation view (RunView).
//
// Why this exists: NewChatBox used to POST the first message fire-and-forget
// and immediately navigate, discarding the turn's authoritative SSE stream.
// The destination page could then only observe the best-effort `/events` bus,
// which never carries the user message and races the turn lifecycle — so the
// first message never showed. Instead we stash the text, navigate, and let
// RunView send it through its normal optimistic + streaming path, identical to
// every subsequent message.

const KEY_PREFIX = "task-orch:pending-first-message:";

/** Minimal subset of the Web Storage API we depend on (injectable for tests). */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// In-memory fallback for contexts where sessionStorage is unavailable or
// throws (sandboxed iframes, site data blocked, some lockdown/private modes).
// The handoff only needs to survive a single client-side navigation, so a
// module-level Map — which lives for the lifetime of the SPA bundle — is
// enough to keep the first message from being silently dropped.
const memoryFallback = new Map<string, string>();

function resolveStore(explicit?: StorageLike): StorageLike | null {
  if (explicit) return explicit;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // sessionStorage can throw in some sandboxed/private contexts.
    return null;
  }
}

/**
 * Stash a run's first message for the destination conversation view to pick up.
 * Prefers the provided/session storage but falls back to an in-memory Map when
 * storage is missing or a write throws, so the handoff is never a silent no-op.
 * Returns whether the message was stashed anywhere (always true today; the
 * boolean lets callers add their own fallback if that ever changes).
 */
export function stashPendingMessage(runId: number, text: string, store?: StorageLike): boolean {
  const key = KEY_PREFIX + runId;
  const s = resolveStore(store);
  if (s) {
    try {
      s.setItem(key, text);
      return true;
    } catch {
      // Storage present but the write failed (quota / private mode) — fall
      // through to the in-memory fallback below.
    }
  }
  memoryFallback.set(key, text);
  return true;
}

/**
 * Read and remove the pending message for a run. Returns null if none was
 * stashed. Removing on read makes this safe against React StrictMode double
 * invocation and against replaying the message on a page refresh. Consults the
 * in-memory fallback when storage is unavailable or holds nothing for the run.
 */
export function takePendingMessage(runId: number, store?: StorageLike): string | null {
  const key = KEY_PREFIX + runId;
  const s = resolveStore(store);
  if (s) {
    try {
      const value = s.getItem(key);
      if (value !== null) {
        s.removeItem(key);
        return value;
      }
    } catch {
      // Fall through to the in-memory fallback.
    }
  }
  const mem = memoryFallback.get(key);
  if (mem !== undefined) {
    memoryFallback.delete(key);
    return mem;
  }
  return null;
}
