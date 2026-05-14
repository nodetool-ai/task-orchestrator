import { describe, expect, it } from "vitest";
import { abortBridgeFactory } from "../../lib/extensions/abort-bridge";

describe("abortBridgeFactory", () => {
  it("calls ctx.abort() when the AbortController is aborted after agent_start", () => {
    const handlers = new Map<string, Function>();
    const pi: any = { on: (e: string, h: Function) => handlers.set(e, h), registerTool: () => {} };
    const abort = new AbortController();
    abortBridgeFactory(abort)(pi);
    let aborted = false;
    const ctx = { abort: () => { aborted = true; } };
    handlers.get("agent_start")!({}, ctx);
    abort.abort();
    expect(aborted).toBe(true);
  });

  it("is safe if ctx.abort throws", () => {
    const handlers = new Map<string, Function>();
    const pi: any = { on: (e: string, h: Function) => handlers.set(e, h), registerTool: () => {} };
    const abort = new AbortController();
    abortBridgeFactory(abort)(pi);
    const ctx = { abort: () => { throw new Error("nope"); } };
    handlers.get("agent_start")!({}, ctx);
    expect(() => abort.abort()).not.toThrow();
  });
});
