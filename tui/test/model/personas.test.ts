import { describe, expect, it } from "vitest";
import { PERSONA_SUGGESTIONS, applyPersonaCompletion, completePersona, matchPersonas } from "../../src/model/personas.js";

const PERSONAS = [
  { id: "implementor", name: "Implementor" },
  { id: "reviewer", name: "Code reviewer" },
  { id: "planner", name: "Planner" },
];

describe("/new persona completion", () => {
  it("offers personas once the command has its argument space", () => {
    expect(matchPersonas("/new", PERSONAS)).toEqual([]);
    expect(matchPersonas("/new ", PERSONAS).map((p) => p.value)).toEqual(["implementor", "reviewer", "planner"]);
  });

  it("matches ids and display names, case-insensitively", () => {
    expect(matchPersonas("/new imp", PERSONAS).map((p) => p.value)).toEqual(["implementor"]);
    expect(matchPersonas("/new CODE", PERSONAS).map((p) => p.value)).toEqual(["reviewer"]);
  });

  it("stops suggesting after an exact persona or a free-form goal", () => {
    expect(matchPersonas("/new implementor", PERSONAS)).toEqual([]);
    expect(matchPersonas("/new implementor ship it", PERSONAS)).toEqual([]);
  });

  it("uses the canonical id and leaves a space for the goal", () => {
    expect(applyPersonaCompletion("/new imp", "implementor")).toBe("/new implementor ");
    expect(completePersona("/new Code reviewer", PERSONAS)).toBeNull();
    expect(completePersona("/new Implementor", PERSONAS)).toBe("/new implementor ");
    expect(completePersona("/new implementor ", PERSONAS)).toBeNull();
  });

  it("caps the suggestion list", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `p-${i}`, name: `Persona ${i}` }));
    expect(matchPersonas("/new ", many)).toHaveLength(PERSONA_SUGGESTIONS);
  });
});
