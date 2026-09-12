import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { JsonlLogRecordExporter, setupDiagnostics } from "../lib/worker-runtime/diagnostics";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";

async function lines(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("worker local diagnostics", () => {
  it("writes bounded, filtered records with gaps-safe sequence and mutable attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-orch-diag-"));
    try {
      const diagnostics = setupDiagnostics({ runId: 288, instanceId: "instance-a", sessionRoot: root, maxRecordBytes: 512 });
      diagnostics.rawSdkEvent("item.started");
      diagnostics.meaningfulProgress("tool output", "item-1");
      diagnostics.emit("backend.started", {
        invocation_id: "inv-1",
        "model.provider": "anthropic",
        prompt: "this must never be emitted",
        huge: "this must never be emitted",
      });
      diagnostics.setAttempt(2);
      diagnostics.emit("tool.started", { "tool.name": "Bash", "tool.item_id": "item-1" });
      diagnostics.emit("tool.finished", { "tool.name": "Bash", "tool.item_id": "item-1", outcome: "completed" });
      expect(await diagnostics.forceFlush()).toBe(true);
      await diagnostics.shutdown();
      const current = join(root, "logs", "diagnostics-288-instance-a.jsonl");
      const output = await lines(current);
      expect(output).toHaveLength(3);
      expect(output[0]).toMatchObject({ event: "backend.started", run_id: 288, stream_id: expect.any(String) });
      expect(output[1]).toMatchObject({ event: "tool.started", attempt: 2 });
      expect(output[2]).toMatchObject({ event: "tool.finished", attempt: 2 });
      for (const line of output) {
        expect(Buffer.byteLength(JSON.stringify(line) + "\n")).toBeLessThanOrEqual(512);
        expect(line).not.toHaveProperty("prompt");
        expect(line).not.toHaveProperty("huge");
      }
      expect(diagnostics.snapshot().open_tool_count).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rotates only after a complete batch and preserves monotonic sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-orch-diag-"));
    try {
      const diagnostics = setupDiagnostics({ runId: 1, instanceId: "i", sessionRoot: root, maxRecordBytes: 256, rotationBytes: 256 });
      for (let i = 0; i < 5; i++) diagnostics.emit(`event.${i}`, { outcome: "ok" });
      await diagnostics.forceFlush();
      await diagnostics.shutdown();
      const files = await readdir(join(root, "logs"));
      expect(files.filter((f) => f.endsWith(".jsonl") || f.includes(".jsonl.")).length).toBe(2);
      const all = (await Promise.all(files.filter((f) => f.includes(".jsonl")).map((f) => lines(join(root, "logs", f))))).flat();
      const sequences = all.map((r) => Number(r.seq));
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails overlapping export without stacking writes and reports the drop", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-orch-diag-"));
    try {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const appendFile = vi.fn(() => pending);
      const exporter = new JsonlLogRecordExporter({ runId: 2, instanceId: "i", sessionRoot: root, fs: { appendFile: appendFile as any } });
      const record = { hrTime: [1, 0], hrTimeObserved: [1, 0], severityNumber: SeverityNumber.INFO, severityText: "INFO", body: "one", attributes: {}, resource: {} as any, instrumentationScope: {} as any, droppedAttributesCount: 0 } as ReadableLogRecord;
      const first = new Promise<void>((resolve) => exporter.export([record], () => resolve()));
      let failed = false;
      exporter.export([record], (result) => { failed = result.code !== 0; });
      expect(failed).toBe(true);
      release();
      await first;
      await exporter.shutdown();
      expect(appendFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns from shutdown when the filesystem never settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "task-orch-diag-"));
    try {
      const stuck = new Promise<void>(() => undefined);
      const diagnostics = setupDiagnostics({ runId: 3, instanceId: "i", sessionRoot: root, fs: { appendFile: (() => stuck) as any } });
      diagnostics.emit("backend.started");
      const started = Date.now();
      expect(await diagnostics.shutdown(20)).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
