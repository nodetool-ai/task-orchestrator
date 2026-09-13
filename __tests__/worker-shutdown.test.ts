import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedShutdownStep, shutdownWorker, WorkerShutdownError,
  writeWorkerExitEvidence, type WorkerExitEvidence,
} from "../lib/worker-runtime/worker-shutdown";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "worker-exit-"));
  roots.push(root);
  return root;
}
function evidence(instance = "a"): WorkerExitEvidence {
  return {
    version: 1, runId: 295, instanceId: `wi_${instance.repeat(32)}`,
    workerGeneration: 3, pid: 1452, state: "exiting", reason: "controller_lost",
    at: new Date().toISOString(),
  };
}

describe("durable bounded worker shutdown", () => {
  it("atomically records generation evidence without consuming an old incarnation's outbox", async () => {
    const root = await temporaryRoot();
    const oldChannel = join(root, "workers", evidence("b").instanceId, "channel");
    await mkdir(oldChannel, { recursive: true });
    await writeFile(join(oldChannel, "state.json"), "old receipt state");
    const marker = evidence();
    await writeWorkerExitEvidence(root, marker);
    const directory = join(root, "workers", marker.instanceId);
    expect(JSON.parse(await readFile(join(directory, "exit.json"), "utf8"))).toEqual(marker);
    expect((await stat(join(directory, "exit.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["exit.json"]);
    expect(await readFile(join(oldChannel, "state.json"), "utf8")).toBe("old receipt state");
  });

  it("records exit evidence before abort and bounds a disconnected session's stuck drain", async () => {
    const root = await temporaryRoot();
    const marker = evidence();
    let markerAtAbort: Promise<string> | undefined;
    const abort = vi.fn((reason) => {
      expect(reason).toBeInstanceOf(WorkerShutdownError);
      markerAtAbort = readFile(join(root, "workers", marker.instanceId, "exit.json"), "utf8");
    });
    const close = vi.fn(() => new Promise<void>(() => {}));
    const result = await shutdownWorker({ sessionRoot: root, evidence: marker, abort, close, timeoutMs: 500 });
    expect(result).toEqual({ evidenceWritten: true, drained: false });
    expect(JSON.parse(await markerAtAbort!)).toEqual(marker);
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("still closes when an abort listener throws and reports the cleanup failure", async () => {
    const root = await temporaryRoot();
    const close = vi.fn(async () => {});
    const result = await shutdownWorker({
      sessionRoot: root, evidence: evidence(), close,
      abort: () => { throw new Error("broken abort callback"); },
    });
    expect(result).toEqual({ evidenceWritten: true, drained: false });
    expect(close).toHaveBeenCalledOnce();
  });

  it("continues abort/drain when durable evidence cannot be written", async () => {
    const root = await temporaryRoot();
    const file = join(root, "not-a-directory");
    await writeFile(file, "file");
    const abort = vi.fn();
    const close = vi.fn(async () => {});
    const result = await shutdownWorker({ sessionRoot: file, evidence: evidence(), abort, close });
    expect(result).toEqual({ evidenceWritten: false, drained: true });
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("catches up shutdown after a VM resumes past its wall-clock deadline", async () => {
    vi.useFakeTimers();
    const result = boundedShutdownStep(() => new Promise(() => {}), 5_000);
    vi.setSystemTime(Date.now() + 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes late operation rejections after the shutdown bound", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const result = boundedShutdownStep(() => new Promise((_, fail) => { reject = fail; }), 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toBe(false);
    reject(new Error("late send failure"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
