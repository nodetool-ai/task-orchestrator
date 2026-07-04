import { describe, expect, it } from "vitest";
import { tailForStorage, WORKER_LOG_MAX_CHARS } from "../lib/runner/worker-log-store";

describe("tailForStorage", () => {
  it("returns short text unchanged", () => {
    const text = "hello worker log";
    expect(tailForStorage(text)).toBe(text);
  });

  it("returns exactly-at-cap text unchanged", () => {
    const text = "a".repeat(WORKER_LOG_MAX_CHARS);
    expect(tailForStorage(text)).toBe(text);
  });

  it("truncates long text to the cap and keeps the TAIL", () => {
    // Prefix that must be dropped, then a distinctive tail we keep.
    const tail = "b".repeat(WORKER_LOG_MAX_CHARS);
    const text = "OLDEST-PREFIX-DROP-ME" + tail;
    const out = tailForStorage(text);
    expect(out.length).toBe(WORKER_LOG_MAX_CHARS);
    expect(out).toBe(tail);
    expect(out).not.toContain("PREFIX");
  });

  it("strips a leading lone low surrogate when the cut lands mid-pair", () => {
    // "😀" (U+1F600) is the surrogate pair 😀. Position it so the
    // last WORKER_LOG_MAX_CHARS chars begin on the low surrogate \uDE00 — an
    // invalid lone low surrogate Postgres would reject. It must be stripped, so
    // the result is one char shorter than the cap and starts with real text.
    const text = "😀" + "c".repeat(WORKER_LOG_MAX_CHARS - 1);
    const out = tailForStorage(text);
    // Cut keeps [\uDE00, c*(cap-1)]; the leading \uDE00 is dropped → cap-1 chars.
    expect(out.length).toBe(WORKER_LOG_MAX_CHARS - 1);
    expect(out.charCodeAt(0)).toBe("c".charCodeAt(0));
    expect(out).toBe("c".repeat(WORKER_LOG_MAX_CHARS - 1));
  });
});
