import { describe, expect, it } from "vitest";
import { getDefaultModel } from "../lib/chat";

// Regression: new chats are created with getDefaultModel() as run.model.
// The model is now a per-run choice (no persona fallback); runOneTurn() splits
// a "provider/modelId" into provider + id and only defaults a *bare* value to
// the anthropic provider. Keeping the default provider-qualified makes the
// resolved provider explicit so a brand-new chat's first turn always targets
// the intended backend.
describe("chat default model", () => {
  it("is provider-qualified so it overrides the persona provider", () => {
    const model = getDefaultModel();
    expect(model).toContain("/");
    const [provider, id] = model.split("/", 2);
    expect(provider.length).toBeGreaterThan(0);
    expect(id.length).toBeGreaterThan(0);
  });
});
