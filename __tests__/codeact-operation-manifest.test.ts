import { describe, expect, it } from "vitest";
import {
  OPERATION_MANIFEST,
  summarizeCoverage,
  type OperationEntry,
} from "../lib/codeact/operation-manifest";

const byId = new Map(OPERATION_MANIFEST.map((e) => [e.id, e]));

describe("CodeAct operation coverage manifest", () => {
  it("has unique ids across every surface", () => {
    expect(byId.size).toBe(OPERATION_MANIFEST.length);
  });

  it("classifies every entry as sdk | alias | excluded", () => {
    for (const e of OPERATION_MANIFEST) {
      expect(["sdk", "alias", "excluded"]).toContain(e.coverage);
    }
  });

  it("gives every sdk entry a proposed namespace", () => {
    const missing = OPERATION_MANIFEST.filter((e) => e.coverage === "sdk" && !e.sdkNamespace);
    expect(missing.map((e) => e.id)).toEqual([]);
  });

  it("justifies every exclusion", () => {
    const unjustified = OPERATION_MANIFEST.filter(
      (e) => e.coverage === "excluded" && !e.exclusionReason,
    );
    expect(unjustified.map((e) => e.id)).toEqual([]);
  });

  it("points every alias at an existing, non-alias canonical entry", () => {
    for (const e of OPERATION_MANIFEST) {
      if (e.coverage !== "alias") continue;
      expect(e.aliasOf, `${e.id} must set aliasOf`).toBeTruthy();
      const target = byId.get(e.aliasOf as string);
      expect(target, `${e.id} → ${e.aliasOf} must resolve`).toBeDefined();
      expect((target as OperationEntry).coverage, `${e.id} must not alias an alias`).not.toBe("alias");
    }
  });

  it("covers all four surfaces, including a recorded UI/server-action finding", () => {
    const summary = summarizeCoverage();
    expect(summary.bySurface.tool).toBeGreaterThan(0);
    expect(summary.bySurface.rest).toBeGreaterThan(0);
    expect(summary.bySurface.cli).toBeGreaterThan(0);
    // UI actions surface is present (the "no server actions" finding).
    expect(summary.bySurface.ui_action).toBeGreaterThan(0);
  });

  it("enumerates the known surface inventory counts", () => {
    const summary = summarizeCoverage();
    // Guards against silently dropping operations: bump deliberately when the
    // product surface changes. Baselines from the T-20260908-0001 inventory.
    expect(summary.bySurface.rest).toBeGreaterThanOrEqual(70);
    expect(summary.bySurface.cli).toBeGreaterThanOrEqual(36);
    // 80 distinct tools + 11 harness built-ins + prefixed/compat aliases.
    expect(summary.bySurface.tool).toBeGreaterThanOrEqual(80);
    expect(summary.total).toBe(OPERATION_MANIFEST.length);
  });

  it("proposes a coherent set of app.* SDK namespaces", () => {
    const summary = summarizeCoverage();
    expect(summary.sdkNamespaces).toBeGreaterThan(50);
    for (const e of OPERATION_MANIFEST) {
      if (e.coverage === "sdk") {
        expect(e.sdkNamespace, `${e.id}`).toMatch(/^app\./);
      }
    }
  });
});
