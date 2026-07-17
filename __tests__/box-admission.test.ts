import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxClient } from "../lib/runner/box-client";
import { BoxRunnerProvider, boxAdmissionDecision } from "../lib/runner/box";

afterEach(() => {
  delete process.env.TASK_ORCH_BOX_TEMPLATE_ID;
});

describe("Box admission", () => {
  it("defers when the selected account/application capacity is exhausted", () => {
    expect(
      boxAdmissionDecision(
        { canStart: true, activeBoxes: 2, maxActiveBoxes: 10 },
        { reservedActive: 1 },
        2
      )
    ).toMatchObject({ decision: "defer" });
  });

  it("uses the lower application cap and reserves an in-flight local claim", () => {
    expect(
      boxAdmissionDecision(
        { canStart: true, activeBoxes: 0, maxActiveBoxes: 10 },
        { reservedActive: 1 },
        1
      )
    ).toMatchObject({ decision: "defer" });
  });

  it("rejects an account that needs billing setup", () => {
    expect(
      boxAdmissionDecision(
        { canStart: false, activeBoxes: 0, maxActiveBoxes: 1, checkoutRequired: true },
        { reservedActive: 0 }
      )
    ).toMatchObject({ decision: "reject", message: expect.stringMatching(/billing/i) });
  });

  it("converts rate limits to defer and billing failures to actionable rejection", async () => {
    // Pin a template so admission's template gate short-circuits and the
    // account/limits error path under test is reached.
    process.env.TASK_ORCH_BOX_TEMPLATE_ID = "bx_pinned";
    const rateLimited = new BoxRunnerProvider({ limits: vi.fn().mockRejectedValue(Object.assign(new Error("rate limited"), { response: new Response("", { status: 429 }) })) } as unknown as BoxClient);
    await expect(rateLimited.admit({ runId: 1, reservedActive: 0 })).resolves.toMatchObject({ decision: "defer" });

    const billing = new BoxRunnerProvider({ limits: vi.fn().mockRejectedValue(Object.assign(new Error("billing"), { response: new Response("", { status: 402 }) })) } as unknown as BoxClient);
    await expect(billing.admit({ runId: 1, reservedActive: 0 })).resolves.toMatchObject({ decision: "reject", message: expect.stringMatching(/billing/i) });
  });
});
