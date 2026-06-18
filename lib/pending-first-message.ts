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

export function stashPendingMessage(runId: number, text: string, store?: StorageLike): void {
  const s = resolveStore(store);
  if (!s) return;
  s.setItem(KEY_PREFIX + runId, text);
}

/**
 * Read and remove the pending message for a run. Returns null if none was
 * stashed. Removing on read makes this safe against React StrictMode double
 * invocation and against replaying the message on a page refresh.
 */
export function takePendingMessage(runId: number, store?: StorageLike): string | null {
  const s = resolveStore(store);
  if (!s) return null;
  const key = KEY_PREFIX + runId;
  const value = s.getItem(key);
  if (value !== null) s.removeItem(key);
  return value;
}
