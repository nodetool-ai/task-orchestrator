// The server-side seed for the run view's template-build stepper: fold the
// persisted runner_box_template_* events for a run into the current state, so
// a run opened mid-build renders the stepper without waiting on the SSE tail.
import { describe, expect, it } from "vitest";
import { db } from "../db";
import { agentEvents } from "../db/schema";
import { create } from "../lib/runs";
import { loadTemplateBuildState } from "../lib/runner/box-template-state";
import { TEMPLATE_BUILD_STEPS, TEMPLATE_EVENT } from "../lib/runner/box-template-events";

async function emit(runId: number, type: string, payload: object, at: Date): Promise<void> {
  await db.insert(agentEvents).values({
    sessionId: runId,
    type,
    payload: JSON.stringify(payload),
    createdAt: at,
  });
}

describe("loadTemplateBuildState", () => {
  it("returns null for a run with no template events", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    expect(await loadTemplateBuildState(run.id)).toBeNull();
  });

  it("folds building + steps into the current building state, anchored to event times", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const t0 = new Date("2026-07-17T20:00:00.000Z");
    const t1 = new Date("2026-07-17T20:00:05.000Z");
    const t2 = new Date("2026-07-17T20:00:07.000Z");
    await emit(run.id, TEMPLATE_EVENT.building, {
      workerSha: "a".repeat(40),
      reason: "no-template",
      steps: [...TEMPLATE_BUILD_STEPS],
      estimatedSeconds: 900,
    }, t0);
    await emit(run.id, TEMPLATE_EVENT.step, { step: "cloning-worker", index: 0, total: 7 }, t1);
    await emit(run.id, TEMPLATE_EVENT.step, { step: "installing-deps", index: 1, total: 7 }, t2);

    const state = await loadTemplateBuildState(run.id);
    expect(state).toMatchObject({
      phase: "building",
      stepIndex: 1,
      startedAt: t0.getTime(),
      stepStartedAt: t2.getTime(),
      estimatedSeconds: 900,
    });
  });

  it("reflects a completed build as ready (stepper then hides)", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const t0 = new Date("2026-07-17T20:00:00.000Z");
    await emit(run.id, TEMPLATE_EVENT.building, { workerSha: "b".repeat(40), reason: "no-template" }, t0);
    await emit(run.id, TEMPLATE_EVENT.ready, { templateId: "bx_x", durationMs: 750_000 }, new Date(t0.getTime() + 750_000));
    const state = await loadTemplateBuildState(run.id);
    expect(state).toMatchObject({ phase: "ready", durationMs: 750_000 });
  });

  it("reflects a failed build with the failing step", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    const t0 = new Date("2026-07-17T20:00:00.000Z");
    await emit(run.id, TEMPLATE_EVENT.building, { workerSha: "c".repeat(40), reason: "no-template" }, t0);
    await emit(run.id, TEMPLATE_EVENT.step, { step: "cloning-worker", index: 0, total: 7 }, new Date(t0.getTime() + 2000));
    await emit(run.id, TEMPLATE_EVENT.failed, { step: "cloning-worker", error: "reference is not a tree" }, new Date(t0.getTime() + 3000));
    const state = await loadTemplateBuildState(run.id);
    expect(state).toMatchObject({ phase: "failed", failedStep: "cloning-worker", error: "reference is not a tree" });
  });
});
