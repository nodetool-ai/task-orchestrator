import { describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushWorkerLogOnce,
  startWorkerLogFlusher,
  tailForStorage,
  WORKER_LOG_MAX_CHARS,
} from "../lib/runner/worker-log-store";

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

// ── Shipping the worker's runner.log off the ephemeral Fly volume ───────────
// Prod, 2026-07-21: every worker logged this every 15s, forever —
//   [worker-log-store] flush failed ... "Direct database access attempted
//   inside a run worker (TASK_ORCH_INSIDE_WORKER=1)"
// The flusher called runTransport(), which is ALWAYS the control plane's db
// transport (lib/worker/index.ts says so in its header), but this module runs
// INSIDE the worker where the db guard blocks it. So worker_log was never
// populated for a Fly run and the feature was pure noise. The worker must ship
// its log over the channel (`worker.log`), which the control plane already
// appends to agent_sessions.worker_log.
describe("startWorkerLogFlusher over the worker channel", () => {
  it("emits only the bytes appended since the previous flush", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-log-flush-"));
    try {
      const file = join(dir, "runner.log");
      await writeFile(file, "first chunk\n");

      const sent: string[] = [];
      const stop = startWorkerLogFlusher(7, file, {
        intervalMs: 0, // no timer; drive it by hand
        sink: async (text) => void sent.push(text),
      });

      await flushWorkerLogOnce(7, file);
      // Append, then flush again — the second batch must NOT resend chunk one,
      // because the channel handler APPENDS each batch (unlike the old
      // writeWorkerLog, which overwrote with the whole tail).
      await appendFile(file, "second chunk\n");
      await flushWorkerLogOnce(7, file);
      await stop();

      expect(sent[0]).toBe("first chunk\n");
      expect(sent[1]).toBe("second chunk\n");
      expect(sent.join("")).not.toContain("first chunk\nfirst chunk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the sink fails — a log flush must not break the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-log-flush-"));
    try {
      const file = join(dir, "runner.log");
      await writeFile(file, "hello\n");
      const stop = startWorkerLogFlusher(7, file, {
        intervalMs: 0,
        sink: async () => {
          throw new Error("channel is gone");
        },
      });
      await expect(flushWorkerLogOnce(7, file)).resolves.toBe(false);
      await expect(stop()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Prod, run 168: the terminal flush logged
//   [worker-log-store] flush failed runId=168 error="worker session is closed"
// because run-worker's finally closed the supervisor BEFORE calling stop().
// The flush emits over the channel, so the last — and most valuable — bytes of
// a run could never land. stop() must still deliver while the sink is alive.
describe("terminal flush", () => {
  it("delivers the tail written after the last periodic tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-log-terminal-"));
    try {
      const file = join(dir, "runner.log");
      await writeFile(file, "early\n");
      const sent: string[] = [];
      const stop = startWorkerLogFlusher(9, file, {
        intervalMs: 0,
        sink: async (text) => void sent.push(text),
      });
      await flushWorkerLogOnce(9, file);
      // Written after the last tick — only the terminal flush can catch it.
      await appendFile(file, "DYING WORDS\n");
      await stop();
      expect(sent.join("")).toContain("DYING WORDS");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
