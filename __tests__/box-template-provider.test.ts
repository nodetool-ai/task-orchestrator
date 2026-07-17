// Spec §5: admission defers behind the template build with run-visible
// reasons; create() forks from the resolved registry template when unpinned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { boxTemplates } from "../db/schema";
import type { BoxClient } from "../lib/runner/box-client";
import { BoxRunnerProvider } from "../lib/runner/box";
import { setTemplateBuildStarter } from "../lib/runner/box-template-registry";
import { create } from "../lib/runs";

const KNOBS = ["TASK_ORCH_RUNNER", "TASK_ORCH_BOX_TEMPLATE_ID", "TASK_ORCH_WORKER_SHA", "TASK_ORCH_BOX_BASE_ID", "BOX_API_KEY"];
afterEach(() => {
  for (const k of KNOBS) delete process.env[k];
  setTemplateBuildStarter(null);
  vi.restoreAllMocks();
});

const limitsOk = { canStart: true, activeBoxes: 0, maxActiveBoxes: 10 };

describe("BoxRunnerProvider template gate", () => {
  it("defers the builder run with the building reason", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "1".repeat(40);
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    // AFTER construction: the constructor registers the real starter, and a
    // real background build against the fake client would race this test.
    setTemplateBuildStarter(vi.fn());
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({
      decision: "defer",
      reason: "Building box template…",
    });
  });

  it("defers a second run behind the builder with the waiting reason", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "2".repeat(40);
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    setTemplateBuildStarter(vi.fn()); // after construction — see test 1
    const builder = await create({ goal: "<implement>", defer: true });
    const waiter = await create({ goal: "<implement>", defer: true });
    await provider.admit({ runId: builder.id, reservedActive: 0 });
    await expect(provider.admit({ runId: waiter.id, reservedActive: 0 })).resolves.toEqual({
      decision: "defer",
      reason: `Waiting for box template build (started by run #${builder.id})`,
    });
  });

  it("falls through to the limits probe when the template is ready", async () => {
    process.env.TASK_ORCH_WORKER_SHA = "3".repeat(40);
    await db.insert(boxTemplates).values({
      workerSha: "3".repeat(40),
      repository: "nodetool-ai/nodetool",
      state: "ready",
      boxId: "bx_ready_tpl",
    });
    const limits = vi.fn(async () => limitsOk);
    const provider = new BoxRunnerProvider({ limits } as unknown as BoxClient);
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({ decision: "admit" });
    expect(limits).toHaveBeenCalled();
  });

  it("skips the registry entirely when a template id is pinned", async () => {
    process.env.TASK_ORCH_BOX_TEMPLATE_ID = "bx_pinned";
    const provider = new BoxRunnerProvider({ limits: vi.fn(async () => limitsOk) } as unknown as BoxClient);
    const starter = vi.fn();
    setTemplateBuildStarter(starter); // after construction — see test 1
    const run = await create({ goal: "<implement>", defer: true });
    await expect(provider.admit({ runId: run.id, reservedActive: 0 })).resolves.toEqual({ decision: "admit" });
    expect(starter).not.toHaveBeenCalled();
  });
});
