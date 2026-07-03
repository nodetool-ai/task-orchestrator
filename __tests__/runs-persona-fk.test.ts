import { describe, expect, it } from "vitest";
import { create } from "../lib/runs";
import { getPersona } from "../lib/repo";

// Regression: agent_runs.persona_id is a foreign key into the personas table.
// Personas are code-defined and were only seeded by the manual `npm run db:seed`
// script, so a migrated-but-unseeded DB made every run-create fail with
// "FOREIGN KEY constraint failed". The DB now seeds required personas at init.

describe("persona foreign key on run create", () => {
  it("seeds the code-defined personas at DB init (FK targets exist)", async () => {
    // No seedPersonas() call here — a freshly opened DB must already have them.
    expect(await getPersona("implementor")).not.toBeNull();
    expect(await getPersona("planning-agent")).not.toBeNull();
  });

  it("creates a run with the default persona without an FK failure", async () => {
    const run = await create({ goal: "<implement>", defer: true });
    expect(run.personaId).toBe("implementor");
  });

  it("rejects an unknown persona with a clear 404, not an opaque SqliteError", async () => {
    await expect(create({ goal: "<implement>", personaId: "no-such-persona", defer: true })).rejects.toThrow(
      /Persona 'no-such-persona' not found/
    );
  });
});
