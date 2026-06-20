import { describe, expect, it } from "vitest";
import { create } from "../lib/runs";
import { getPersona } from "../lib/repo";

// Regression: agent_runs.persona_id is a foreign key into the personas table.
// Personas are code-defined and were only seeded by the manual `npm run db:seed`
// script, so a migrated-but-unseeded DB made every run-create fail with
// "FOREIGN KEY constraint failed". The DB now seeds required personas at init.

describe("persona foreign key on run create", () => {
  it("seeds the code-defined personas at DB init (FK targets exist)", () => {
    // No seedPersonas() call here — a freshly opened DB must already have them.
    expect(getPersona("implementor")).not.toBeNull();
    expect(getPersona("planning-agent")).not.toBeNull();
  });

  it("creates a run with the default persona without an FK failure", () => {
    const run = create({ goal: "<implement>", defer: true });
    expect(run.personaId).toBe("implementor");
  });

  it("rejects an unknown persona with a clear 404, not an opaque SqliteError", () => {
    expect(() => create({ goal: "<implement>", personaId: "no-such-persona", defer: true })).toThrow(
      /Persona 'no-such-persona' not found/
    );
  });
});
