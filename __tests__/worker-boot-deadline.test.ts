import { describe, expect, it } from "vitest";
import { BOOT_DEADLINE_MS } from "../lib/run-dispatch";

// Prod, run 169 (2026-07-21): the run sat in `preparing` and the control plane
// logged
//   Worker channel start failed for run 169: connect ECONNREFUSED fdaa:...:8787
// The worker was fine — it bound its listener normally — but a COLD Fly image
// pull (57s) pushed "machine started" to 61s and the bound listener to ~90s,
// while connectWithBootBackoff gave up at 60s. This reproduces after every
// deploy, because the first run scheduled onto a host pulls the new image.
//
// This guards the headroom, not the exact value: anyone lowering it back under
// a cold boot re-breaks post-deploy dispatch.
describe("worker boot deadline", () => {
  const OBSERVED_COLD_FLY_BOOT_MS = 90_000;

  it("outlasts a cold Fly boot (image pull + machine start + node startup)", () => {
    expect(BOOT_DEADLINE_MS).toBeGreaterThan(OBSERVED_COLD_FLY_BOOT_MS);
  });

  it("keeps meaningful headroom over the observed worst case", () => {
    // A pull slower than the one measured must not immediately re-break it.
    expect(BOOT_DEADLINE_MS).toBeGreaterThanOrEqual(OBSERVED_COLD_FLY_BOOT_MS * 1.5);
  });
});
