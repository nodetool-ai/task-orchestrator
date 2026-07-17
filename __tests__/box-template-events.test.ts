import { describe, expect, it } from "vitest";
import {
  TEMPLATE_BUILD_STEPS,
  TEMPLATE_EVENT,
  emitTemplateBuildLifecycle,
  formatDuration,
  reduceTemplateBuildEvent,
  templateBuildView,
  type TemplateBuildState,
} from "../lib/runner/box-template-events";

const T0 = 1_000_000;

function building(overrides: Record<string, unknown> = {}) {
  return {
    type: TEMPLATE_EVENT.building,
    workerSha: "abc123",
    reason: "no-template",
    steps: [...TEMPLATE_BUILD_STEPS],
    estimatedSeconds: 900,
    ...overrides,
  };
}

describe("reduceTemplateBuildEvent", () => {
  it("starts a build from a building event", () => {
    const s = reduceTemplateBuildEvent(null, building(), T0)!;
    expect(s).toMatchObject({
      phase: "building",
      steps: [...TEMPLATE_BUILD_STEPS],
      stepIndex: -1,
      startedAt: T0,
      stepStartedAt: T0,
      estimatedSeconds: 900,
    });
  });

  it("falls back to the default steps and estimate when the payload omits them", () => {
    const s = reduceTemplateBuildEvent(
      null,
      { type: TEMPLATE_EVENT.building, workerSha: "abc123", reason: "sha-drift" },
      T0
    )!;
    expect(s.steps).toEqual([...TEMPLATE_BUILD_STEPS]);
    expect(s.estimatedSeconds).toBe(900);
  });

  it("advances on step events and stamps stepStartedAt", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
      T0 + 1_000
    );
    expect(s).toMatchObject({ phase: "building", stepIndex: 0, stepStartedAt: T0 + 1_000 });
  });

  it("keeps stepIndex monotonic when a stale step replays out of order", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "installing-deps", index: 1, total: 5 },
      T0 + 2_000
    );
    const after = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
      T0 + 3_000
    )!;
    expect(after.stepIndex).toBe(1);
    expect(after.stepStartedAt).toBe(T0 + 2_000); // stale event does not restamp
  });

  it("ignores a step event with no preceding building event", () => {
    expect(
      reduceTemplateBuildEvent(
        null,
        { type: TEMPLATE_EVENT.step, step: "cloning-worker", index: 0, total: 5 },
        T0
      )
    ).toBeNull();
  });

  it("ready is terminal and wins over stale steps", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.ready, templateId: "bx_tpl1", durationMs: 750_000 },
      T0 + 750_000
    );
    expect(s).toMatchObject({ phase: "ready", durationMs: 750_000 });
    const after = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.step, step: "archiving", index: 4, total: 5 },
      T0 + 751_000
    )!;
    expect(after.phase).toBe("ready");
  });

  it("failed captures the failing step and error", () => {
    let s = reduceTemplateBuildEvent(null, building(), T0);
    s = reduceTemplateBuildEvent(
      s,
      { type: TEMPLATE_EVENT.failed, step: "installing-deps", error: "npm ci exited 1" },
      T0 + 60_000
    );
    expect(s).toMatchObject({
      phase: "failed",
      failedStep: "installing-deps",
      error: "npm ci exited 1",
    });
  });

  it("a ready replay with no prior state still yields a terminal state", () => {
    const s = reduceTemplateBuildEvent(
      null,
      { type: TEMPLATE_EVENT.ready, templateId: "bx_tpl1", durationMs: 750_000 },
      T0
    )!;
    expect(s.phase).toBe("ready");
    expect(s.stepIndex).toBe(TEMPLATE_BUILD_STEPS.length - 1);
  });

  it("returns the input state untouched for unrelated event types", () => {
    const s = reduceTemplateBuildEvent(null, building(), T0);
    expect(reduceTemplateBuildEvent(s, { type: "runner_box_forking" }, T0 + 1)).toBe(s);
  });
});

describe("emitTemplateBuildLifecycle", () => {
  function collector() {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    return {
      events,
      emit: async (type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
    };
  }

  it("emits building → each step with index/total → ready with templateId and duration", async () => {
    const c = collector();
    let t = 0;
    const result = await emitTemplateBuildLifecycle({
      emit: c.emit,
      workerSha: "abc123",
      reason: "no-template",
      steps: ["cloning-worker", "installing-deps"],
      now: () => (t += 1_000),
      build: async (step) => {
        await step("cloning-worker");
        await step("installing-deps");
        return { templateId: "bx_tpl1" };
      },
    });

    expect(result).toEqual({ templateId: "bx_tpl1" });
    expect(c.events.map((e) => e.type)).toEqual([
      TEMPLATE_EVENT.building,
      TEMPLATE_EVENT.step,
      TEMPLATE_EVENT.step,
      TEMPLATE_EVENT.ready,
    ]);
    expect(c.events[0].payload).toMatchObject({
      workerSha: "abc123",
      reason: "no-template",
      steps: ["cloning-worker", "installing-deps"],
      estimatedSeconds: 900,
    });
    expect(c.events[1].payload).toEqual({ step: "cloning-worker", index: 0, total: 2 });
    expect(c.events[2].payload).toEqual({ step: "installing-deps", index: 1, total: 2 });
    expect(c.events[3].payload).toMatchObject({ templateId: "bx_tpl1" });
    expect(typeof c.events[3].payload.durationMs).toBe("number");
  });

  it("emits failed with the current step and rethrows on build error", async () => {
    const c = collector();
    await expect(
      emitTemplateBuildLifecycle({
        emit: c.emit,
        workerSha: "abc123",
        reason: "sha-drift",
        steps: ["cloning-worker", "installing-deps"],
        build: async (step) => {
          await step("cloning-worker");
          await step("installing-deps");
          throw new Error("npm ci exited 1");
        },
      })
    ).rejects.toThrow("npm ci exited 1");
    const last = c.events[c.events.length - 1];
    expect(last.type).toBe(TEMPLATE_EVENT.failed);
    expect(last.payload).toMatchObject({ step: "installing-deps", error: "npm ci exited 1" });
  });

  it("rejects a step name not declared in steps", async () => {
    const c = collector();
    await expect(
      emitTemplateBuildLifecycle({
        emit: c.emit,
        workerSha: "abc123",
        reason: "no-template",
        steps: ["cloning-worker"],
        build: async (step) => {
          await step("mystery-step");
          return { templateId: "bx_tpl1" };
        },
      })
    ).rejects.toThrow(/not declared/);
  });
});

describe("templateBuildView", () => {
  const base: TemplateBuildState = {
    phase: "building",
    steps: ["cloning-worker", "installing-deps", "building-worker"],
    stepIndex: 1,
    startedAt: T0,
    stepStartedAt: T0 + 120_000,
    estimatedSeconds: 900,
  };

  it("labels steps and marks done/active/todo with per-step elapsed", () => {
    const v = templateBuildView(base, T0 + 180_000);
    expect(v.title).toBe("Setting up the box template");
    expect(v.expectation).toBe(
      "One-time setup for this worker build — usually 10–15 minutes. Later runs skip this."
    );
    expect(v.elapsedLabel).toBe("3m 0s");
    expect(v.steps).toEqual([
      { step: "cloning-worker", label: "Cloning worker repo", state: "done" },
      { step: "installing-deps", label: "Installing dependencies", state: "active", elapsedSeconds: 60 },
      { step: "building-worker", label: "Building worker", state: "todo" },
    ]);
    expect(v.showReassurance).toBe(false);
  });

  it("falls back to the raw step name for unknown steps", () => {
    const v = templateBuildView({ ...base, steps: ["mystery-step"], stepIndex: 0 }, T0 + 1_000);
    expect(v.steps[0].label).toBe("mystery-step");
  });

  it("shows reassurance past 1.5× the estimate", () => {
    const v = templateBuildView(base, T0 + 900_000 * 1.5 + 1_000);
    expect(v.showReassurance).toBe(true);
    expect(v.reassurance).toBe("Still working — dependency installs can be slow on cold caches");
  });

  it("collapses to a ready label with the build duration", () => {
    const v = templateBuildView({ ...base, phase: "ready", stepIndex: 2, durationMs: 760_000 }, T0 + 760_000);
    expect(v.readyLabel).toBe("Template ready (12m 40s)");
  });

  it("marks the failing step and carries the error and hint", () => {
    const v = templateBuildView(
      { ...base, phase: "failed", failedStep: "installing-deps", error: "npm ci exited 1" },
      T0 + 300_000
    );
    expect(v.steps[1].state).toBe("failed");
    expect(v.error).toBe("npm ci exited 1");
    expect(v.failureHint).toBe("Re-dispatching the run retries the build.");
  });
});

describe("formatDuration", () => {
  it("formats seconds and minutes", () => {
    expect(formatDuration(40_000)).toBe("40s");
    expect(formatDuration(760_000)).toBe("12m 40s");
    expect(formatDuration(0)).toBe("0s");
  });
});
