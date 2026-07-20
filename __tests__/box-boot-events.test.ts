import { describe, expect, it } from "vitest";
import {
  BOX_BOOT_EVENT,
  BOX_BOOT_STEPS_FORK,
  boxBootView,
  reduceBoxBootEvent,
  type BoxBootState,
} from "../lib/runner/box-boot-events";

const T0 = 1_000_000;

describe("reduceBoxBootEvent", () => {
  it("starts a fork boot from a forking event", () => {
    const s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking, templateId: "bx_tpl1" }, T0)!;
    expect(s).toMatchObject({
      phase: "booting",
      mode: "fork",
      stepIndex: 0,
      startedAt: T0,
      stepStartedAt: T0,
    });
  });

  it("starts a blank boot from a provisioning event", () => {
    const s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.provisioning, mode: "blank" }, T0)!;
    expect(s).toMatchObject({ phase: "booting", mode: "blank", stepIndex: 0 });
  });

  it("advances a blank boot through clone, then worker, then connecting", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.provisioning, mode: "blank" }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.cloning, repository: "a/b" }, T0 + 1_000);
    expect(s).toMatchObject({ stepIndex: 1, stepStartedAt: T0 + 1_000 });
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 4_000);
    expect(s).toMatchObject({ stepIndex: 2 });
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.bootstrapLog }, T0 + 5_000);
    expect(s).toMatchObject({ stepIndex: 3 });
  });

  it("ignores a cloning event on a fork boot (forks inherit the checkout)", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    const after = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.cloning }, T0 + 1_000)!;
    expect(after.stepIndex).toBe(0);
  });

  it("advances to the worker step on ready and restamps stepStartedAt", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready, boxId: "bx1" }, T0 + 2_000);
    expect(s).toMatchObject({ phase: "booting", stepIndex: 1, stepStartedAt: T0 + 2_000 });
  });

  it("advances to the connecting step on the bootstrap log", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 2_000);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.bootstrapLog, captured: true }, T0 + 3_000);
    expect(s).toMatchObject({ phase: "booting", stepIndex: 2, stepStartedAt: T0 + 3_000 });
  });

  it("does not walk backwards when ready arrives after the bootstrap log", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 1_000);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.bootstrapLog }, T0 + 2_000);
    const after = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 3_000)!;
    expect(after.stepIndex).toBe(2); // stale ready does not regress
    expect(after.stepStartedAt).toBe(T0 + 2_000);
  });

  it("channel_hosted is terminal ready with a duration", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 1_000);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.channelHosted, boxId: "bx1" }, T0 + 8_000);
    expect(s).toMatchObject({
      phase: "ready",
      stepIndex: BOX_BOOT_STEPS_FORK.length - 1,
      durationMs: 8_000,
    });
  });

  it("a channel_hosted replay with no prior state still yields a ready state", () => {
    const s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.channelHosted }, T0)!;
    expect(s.phase).toBe("ready");
    expect(s.stepIndex).toBe(BOX_BOOT_STEPS_FORK.length - 1);
  });

  it("runner_failed during boot captures the active step and error message", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.ready }, T0 + 1_000);
    s = reduceBoxBootEvent(
      s,
      { type: BOX_BOOT_EVENT.failed, boxId: "bx1", error: { message: "box refused to start" } },
      T0 + 2_000
    );
    expect(s).toMatchObject({
      phase: "failed",
      failedStep: "starting-worker",
      error: "box refused to start",
    });
  });

  it("accepts a plain string error on runner_failed", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.failed, error: "boom" }, T0 + 1_000);
    expect(s).toMatchObject({ phase: "failed", error: "boom" });
  });

  it("ignores runner_failed once boot has completed (no revival)", () => {
    let s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    s = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.channelHosted }, T0 + 5_000);
    const after = reduceBoxBootEvent(s, { type: BOX_BOOT_EVENT.failed, error: "later rotation" }, T0 + 60_000)!;
    expect(after.phase).toBe("ready");
  });

  it("ignores runner_failed with no boot in flight", () => {
    expect(reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.failed, error: "x" }, T0)).toBeNull();
  });

  it("returns the input state untouched for unrelated event types", () => {
    const s = reduceBoxBootEvent(null, { type: BOX_BOOT_EVENT.forking }, T0);
    expect(reduceBoxBootEvent(s, { type: "runner_box_template_step" }, T0 + 1)).toBe(s);
  });
});

describe("boxBootView", () => {
  const base: BoxBootState = {
    phase: "booting",
    mode: "fork",
    stepIndex: 1,
    startedAt: T0,
    stepStartedAt: T0 + 4_000,
  };

  it("labels fork steps and marks done/active/todo with per-step elapsed", () => {
    const v = boxBootView(base, T0 + 10_000);
    expect(v.title).toBe("Booting the box");
    expect(v.elapsedLabel).toBe("10s");
    expect(v.steps).toEqual([
      { step: "starting-box", label: "Forking the box", state: "done" },
      { step: "starting-worker", label: "Starting the worker", state: "active", elapsedSeconds: 6 },
      { step: "connecting", label: "Connecting the agent channel", state: "todo" },
    ]);
  });

  it("labels the first step differently for blank provisioning", () => {
    const v = boxBootView({ ...base, mode: "blank", stepIndex: 0 }, T0 + 1_000);
    expect(v.steps[0].label).toBe("Creating the box");
  });

  it("shows the clone as its own step for blank provisioning only", () => {
    const blank = boxBootView({ ...base, mode: "blank", stepIndex: 1 }, T0 + 5_000);
    expect(blank.steps.map((s) => s.step)).toEqual([
      "starting-box",
      "cloning-repo",
      "starting-worker",
      "connecting",
    ]);
    expect(blank.steps[1]).toMatchObject({ label: "Cloning the repository", state: "active" });

    const fork = boxBootView(base, T0 + 5_000);
    expect(fork.steps.map((s) => s.step)).not.toContain("cloning-repo");
  });

  it("collapses to a ready label with the boot duration", () => {
    const v = boxBootView(
      { ...base, phase: "ready", stepIndex: BOX_BOOT_STEPS_FORK.length - 1, durationMs: 9_000 },
      T0 + 9_000
    );
    expect(v.readyLabel).toBe("Box ready (9s)");
    expect(v.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("marks the failing step and carries the error and hint", () => {
    const v = boxBootView(
      { ...base, phase: "failed", stepIndex: 1, error: "box refused to start" },
      T0 + 5_000
    );
    expect(v.steps[1].state).toBe("failed");
    expect(v.error).toBe("box refused to start");
    expect(v.failureHint).toBe("Re-sending the message retries provisioning.");
  });
});
