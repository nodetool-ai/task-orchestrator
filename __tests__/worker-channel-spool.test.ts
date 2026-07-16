import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerOutbox, OUTBOX_FILENAME, STATE_FILENAME } from "../lib/worker-channel/spool";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-channel-spool-"));
  roots.push(root);
  return root;
}

function event(
  runId: number,
  instanceId: string,
  seq: number,
  id = `event-${seq}`,
  payload: unknown = { seq },
) {
  return {
    v: 1,
    type: "agent.event",
    id,
    runId,
    instanceId,
    controllerEpoch: 1,
    seq,
    sentAt: "2026-07-15T00:00:00.000Z",
    payload,
  };
}

describe("WorkerOutbox", () => {
  it("persists events, replays after a restart, and applies cumulative acks", async () => {
    const root = await makeRoot();
    const first = await WorkerOutbox.open(root, 7, "wi-test");
    await first.append(event(7, "wi-test", first.nextSeq()));
    await first.append(event(7, "wi-test", first.nextSeq()));
    expect(first.bytesInFlight()).toBeGreaterThan(0);
    await first.close();

    const second = await WorkerOutbox.open(root, 7, "wi-test");
    expect(second.nextSeq()).toBe(3);
    expect((await second.listAfter(0)).map((frame) => frame.seq)).toEqual([1, 2]);
    await second.ackThrough(1);
    expect((await second.listAfter(0)).map((frame) => frame.seq)).toEqual([2]);
    expect(second.bytesInFlight()).toBeGreaterThan(0);
    await second.close();

    const third = await WorkerOutbox.open(root, 7, "wi-test");
    expect((await third.listAfter(0)).map((frame) => frame.seq)).toEqual([2]);
    await third.close();
  });

  it("keeps the sequence high-water mark across compaction and restart", async () => {
    const root = await makeRoot();
    const outbox = await WorkerOutbox.open(root, 8, "wi-monotonic");
    for (let seq = 1; seq <= 1_000; seq += 1) {
      await outbox.append(event(8, "wi-monotonic", seq));
    }
    await outbox.ackThrough(1_000);
    expect(outbox.nextSeq()).toBe(1_001);
    expect(await outbox.listAfter(0)).toEqual([]);
    const compacted = await readFile(join(root, "channel", OUTBOX_FILENAME), "utf8");
    expect(compacted).toBe("");
    await outbox.close();

    const restarted = await WorkerOutbox.open(root, 8, "wi-monotonic");
    expect(restarted.nextSeq()).toBe(1_001);
    await restarted.append(event(8, "wi-monotonic", restarted.nextSeq()));
    expect((await restarted.listAfter(1_000)).map((frame) => frame.seq)).toEqual([1_001]);
    await restarted.close();
    // 1,000 durable appends each fsync before resolving, which is well over the
    // default 5s vitest budget on slower disks.
  }, 30_000);

  it("ignores one final truncated JSON line but rejects complete-line corruption", async () => {
    const root = await makeRoot();
    const outbox = await WorkerOutbox.open(root, 9, "wi-corruption");
    await outbox.append(event(9, "wi-corruption", 1));
    await outbox.close();
    const path = join(root, "channel", OUTBOX_FILENAME);
    await appendFile(path, '{"v":1,"type":"agent.event"');
    const reopened = await WorkerOutbox.open(root, 9, "wi-corruption");
    expect((await reopened.listAfter(0)).map((frame) => frame.seq)).toEqual([1]);
    await reopened.close();

    const lines = (await readFile(path, "utf8")).split("\n");
    lines[0] = "not-json";
    await writeFile(path, lines.join("\n"));
    await expect(WorkerOutbox.open(root, 9, "wi-corruption")).rejects.toThrow(/corrupt complete/);
  });

  it("rejects state and event scope mismatches", async () => {
    const root = await makeRoot();
    const outbox = await WorkerOutbox.open(root, 10, "wi-scope");
    await outbox.append(event(10, "wi-scope", 1));
    await outbox.close();
    await expect(WorkerOutbox.open(root, 11, "wi-scope")).rejects.toThrow(/scope mismatch/);

    const otherRoot = await makeRoot();
    const other = await WorkerOutbox.open(otherRoot, 10, "wi-scope");
    await expect(other.append(event(10, "wi-other", 1))).rejects.toThrow(/scope mismatch/);
    await other.close();
  });

  it("makes duplicate ids idempotent and rejects changed contents", async () => {
    const root = await makeRoot();
    const outbox = await WorkerOutbox.open(root, 12, "wi-duplicate");
    const frame = event(12, "wi-duplicate", 1, "stable-id", { value: "one" });
    await outbox.append(frame);
    await outbox.append({ ...frame });
    expect((await outbox.listAfter(0)).map((item) => item.id)).toEqual(["stable-id"]);
    await expect(
      outbox.append(event(12, "wi-duplicate", 2, "stable-id", { value: "two" })),
    ).rejects.toThrow(/different contents/);
    await outbox.close();
  });

  it("waits for and signals capacity after an acknowledgement", async () => {
    const root = await makeRoot();
    const first = event(13, "wi-backpressure", 1, "first", { text: "a".repeat(80) });
    const second = event(13, "wi-backpressure", 2, "second", { text: "b".repeat(80) });
    const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);
    const outbox = await WorkerOutbox.open(root, 13, "wi-backpressure", {
      maxInFlightBytes: firstBytes + 1,
    });
    await outbox.append(first);
    let completed = false;
    const pending = outbox.append(second).then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    await outbox.ackThrough(1);
    await pending;
    expect(completed).toBe(true);
    await outbox.close();
  });

  it("uses private file permissions for the state and outbox", async () => {
    const root = await makeRoot();
    const outbox = await WorkerOutbox.open(root, 14, "wi-mode");
    await outbox.close();
    for (const filename of [OUTBOX_FILENAME, STATE_FILENAME]) {
      const file = await stat(join(root, "channel", filename));
      expect(file.mode & 0o777).toBe(0o600);
    }
  });
});

