import { describe, expect, it } from "vitest";
import { orchestratorExtension } from "../../lib/extensions/agent";

function makeStub() {
  const calls: Array<{ name: string; def: any }> = [];
  const pi: any = {
    registerTool: (def: any) => { calls.push({ name: def.name, def }); },
    on: () => {},
  };
  return { calls, pi };
}

describe("orchestratorExtension", () => {
  it("registers 31 task_orch tools", () => {
    const { calls, pi } = makeStub();
    orchestratorExtension({ author: "test" })(pi);
    expect(calls.length).toBe(31);
    for (const c of calls) {
      expect(c.name).toMatch(/^task_orch__/);
      expect(c.def.label).toBeDefined();
      expect(c.def.description).toBeDefined();
      expect(c.def.parameters).toBeDefined();
    }
  });
});
