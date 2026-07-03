import { describe, expect, it } from "vitest";
import { create, get } from "../lib/runs";

// Reasoning level is a per-run choice (like model): the user or a calling agent
// passes it on create; it overrides the persona's level at run time and falls
// back to the persona when omitted.

describe("per-run reasoning (thinkingLevel)", () => {
  it("persists the level passed on create", async () => {
    const run = await create({ goal: "<implement>", thinkingLevel: "high", defer: true });
    expect(run.thinkingLevel).toBe("high");
    expect((await get(run.id))?.thinkingLevel).toBe("high");
  });

  it("defaults to null (inherit persona) when omitted", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    expect(run.thinkingLevel).toBeNull();
    expect((await get(run.id))?.thinkingLevel).toBeNull();
  });

  it("accepts each level", async () => {
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      const run = await create({ goal: "<implement>", thinkingLevel: level, defer: true });
      expect(run.thinkingLevel).toBe(level);
    }
  });
});
