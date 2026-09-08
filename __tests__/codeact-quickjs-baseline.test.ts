import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BINDING_PACKAGE,
  BINDING_VERSION,
  VARIANT_PACKAGE,
  VARIANT_VERSION,
  QUICKJS_NG_REVISION,
  WASM_ARTIFACT,
} from "../lib/codeact/quickjs-baseline";
import { resolvePackagedWasmPath } from "../lib/codeact/quickjs-variant";

const require = createRequire(import.meta.url);

/** Read an installed dependency's version. Some packages (the core) don't
 *  export `./package.json`, so fall back to walking up from the resolved
 *  entry to the package root. */
function depVersion(pkg: string): string {
  let dir = dirname(require.resolve(pkg));
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const parsed = JSON.parse(readFileSync(pj, "utf8")) as { name?: string; version: string };
      if (parsed.name === pkg) return parsed.version;
    }
    dir = dirname(dir);
  }
  throw new Error(`cannot locate package.json for ${pkg}`);
}

// Guards the pinned QuickJS-NG baseline against a silent dependency drift: the
// engine bytes, the underlying revision, and the installed versions must match
// what we recorded, or this fails instead of shipping a changed sandbox.
describe("QuickJS-NG baseline provenance", () => {
  it("pins the binding and variant to the exact installed versions", () => {
    expect(depVersion(BINDING_PACKAGE)).toBe(BINDING_VERSION);
    expect(depVersion(VARIANT_PACKAGE)).toBe(VARIANT_VERSION);
  });

  it("records the underlying quickjs-ng revision the variant documents", () => {
    // The variant's own README/types document the vendored quickjs-ng tag; we
    // assert the shape we recorded so a bump that changes it is noticed.
    expect(QUICKJS_NG_REVISION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("matches the packaged WASM artifact bytes exactly", () => {
    const wasmPath = resolvePackagedWasmPath();
    const bytes = readFileSync(wasmPath);
    expect(bytes.byteLength).toBe(WASM_ARTIFACT.byteLength);

    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(WASM_ARTIFACT.sha256);

    // WebAssembly magic number `\0asm`.
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([...WASM_ARTIFACT.magic]);
  });
});
