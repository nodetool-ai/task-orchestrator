import { describe, expect, it } from "vitest";
import {
  stashPendingMessage,
  takePendingMessage,
  type StorageLike,
} from "../lib/pending-first-message";

// The /chat composer hands a brand-new run's first message to the conversation
// view through one-shot storage, so RunView can send it via its authoritative
// optimistic+SSE path instead of firing-and-forgetting it on navigation. The
// read-once semantics matter: a refresh must not replay the message.

function fakeStore(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("pending first message handoff", () => {
  it("returns the stashed text for the matching run", () => {
    const store = fakeStore();
    stashPendingMessage(42, "hello agent", store);
    expect(takePendingMessage(42, store)).toBe("hello agent");
  });

  it("is read-once: a second take returns null (no replay on refresh)", () => {
    const store = fakeStore();
    stashPendingMessage(42, "hello agent", store);
    expect(takePendingMessage(42, store)).toBe("hello agent");
    expect(takePendingMessage(42, store)).toBeNull();
  });

  it("returns null when nothing was stashed", () => {
    const store = fakeStore();
    expect(takePendingMessage(7, store)).toBeNull();
  });

  it("isolates messages by run id", () => {
    const store = fakeStore();
    stashPendingMessage(1, "for one", store);
    stashPendingMessage(2, "for two", store);
    expect(takePendingMessage(2, store)).toBe("for two");
    expect(takePendingMessage(1, store)).toBe("for one");
  });
});
