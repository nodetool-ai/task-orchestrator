// `/model` completion is pure arithmetic (src/model/models.ts): the catalog
// reshape, the match ranking and the token swap. No renderer, so every rule an
// operator can feel at the keyboard is asserted here.

import { describe, expect, it } from "vitest";
import {
  MODEL_SUGGESTIONS,
  applyModelCompletion,
  matchModels,
  modelOptions,
  type ModelOption,
} from "../../src/model/models.js";

const CATALOG = [
  { id: "anthropic", models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }] },
  { id: "openai", models: [{ id: "gpt-6", name: "GPT-6" }] },
];

const MODELS: ModelOption[] = [
  { value: "anthropic/claude-fable-5", label: "Claude Fable 5" },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "openai/gpt-6", label: "GPT-6" },
];

describe("modelOptions", () => {
  it("qualifies every model with its provider and sorts by id", () => {
    expect(modelOptions({ providers: [], backends: CATALOG.map((p) => ({ id: p.id, providers: [p] })), defaultBackend: "claude" }).map((m) => m.value)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-6",
    ]);
  });

  it("deduplicates a model two backends both ship", () => {
    const res = {
      providers: [],
      backends: [
        ...CATALOG.map((p) => ({ id: p.id, providers: [p] })),
        { id: "claude", providers: CATALOG.slice(0, 1) },
      ],
      defaultBackend: "claude",
    };
    expect(modelOptions(res)).toHaveLength(2);
  });

  it("tolerates a backend with no catalog yet", () => {
    const res = { providers: [], backends: [{ id: "pi", providers: [] }], defaultBackend: "pi" };
    expect(modelOptions(res)).toEqual([]);
  });
});

describe("matchModels", () => {
  it("offers nothing until /model has its space", () => {
    expect(matchModels("/model", MODELS)).toEqual([]);
    expect(matchModels("/mode", MODELS)).toEqual([]);
    expect(matchModels("/modelx cla", MODELS)).toEqual([]);
    expect(matchModels("tell me about /model", MODELS)).toEqual([]);
  });

  it("lists the catalog on a bare `/model `", () => {
    expect(matchModels("/model ", MODELS)).toEqual(MODELS);
  });

  it("matches a prefix of the qualified id first", () => {
    expect(matchModels("/model anthropic/claude-s", MODELS).map((m) => m.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("finds sonnet without the provider prefix", () => {
    expect(matchModels("/model sonnet", MODELS).map((m) => m.value)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("matches the display name too", () => {
    expect(matchModels("/model haiku", MODELS).map((m) => m.value)).toEqual([
      "anthropic/claude-haiku-4-5",
    ]);
    expect(matchModels("/model gpt", MODELS).map((m) => m.value)).toEqual(["openai/gpt-6"]);
  });

  it("is case-insensitive", () => {
    expect(matchModels("/model GPT", MODELS).map((m) => m.value)).toEqual(["openai/gpt-6"]);
  });

  it("goes quiet once the typed id already names one model", () => {
    expect(matchModels("/model openai/gpt-6", MODELS)).toEqual([]);
    // …and hands the keyboard back in every other respect.
    expect(matchModels("/model nope", MODELS)).toEqual([]);
  });

  it("caps the list so the composer keeps its transcript", () => {
    const many: ModelOption[] = Array.from({ length: 50 }, (_, i) => ({
      value: `prov/m-${i}`,
      label: `M ${i}`,
    }));
    expect(matchModels("/model ", many)).toHaveLength(MODEL_SUGGESTIONS);
  });

  it("says nothing while the catalog is cold", () => {
    expect(matchModels("/model sonnet", [])).toEqual([]);
  });
});

describe("applyModelCompletion", () => {
  it("replaces the half-typed argument and keeps the command", () => {
    expect(applyModelCompletion("/model cla", "anthropic/claude-sonnet-5")).toBe(
      "/model anthropic/claude-sonnet-5",
    );
    expect(applyModelCompletion("/model ", "openai/gpt-6")).toBe("/model openai/gpt-6");
    expect(applyModelCompletion("/model", "openai/gpt-6")).toBe("/model openai/gpt-6");
  });
});
