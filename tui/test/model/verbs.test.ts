import { describe, expect, it } from "vitest";
import { SPINNER_VERBS, verbFor } from "../../src/model/verbs.js";

describe("verbFor", () => {
  it("gives a run the same word every time it is asked", () => {
    expect(verbFor(42)).toBe(verbFor(42));
    expect(SPINNER_VERBS).toContain(verbFor(42));
  });

  it("answers for any id a server can hand out", () => {
    for (const id of [0, 1, 7, 999_999, -3]) expect(SPINNER_VERBS).toContain(verbFor(id));
  });

  it("keeps every verb short enough to leave room for the byline", () => {
    for (const v of SPINNER_VERBS) expect(v.length).toBeLessThanOrEqual(16);
  });
});
