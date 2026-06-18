import { describe, expect, it } from "vitest";
import { abortBridgeFactory } from "../../lib/extensions/abort-bridge";
import { makeRegistrar } from "../helpers/fake-registrar";

describe("abortBridgeFactory", () => {
  it("calls ctx.abort() when the AbortController is aborted after agent start", () => {
    const r = makeRegistrar();
    const abort = new AbortController();
    abortBridgeFactory(abort)(r.reg);
    let aborted = false;
    r.agentStartFns[0]({ abort: () => { aborted = true; } });
    abort.abort();
    expect(aborted).toBe(true);
  });

  it("is safe if ctx.abort throws", () => {
    const r = makeRegistrar();
    const abort = new AbortController();
    abortBridgeFactory(abort)(r.reg);
    r.agentStartFns[0]({ abort: () => { throw new Error("nope"); } });
    expect(() => abort.abort()).not.toThrow();
  });
});
