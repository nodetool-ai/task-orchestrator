// lib/codeact/wasm-fixture.ts
//
// Packages the QuickJS-NG WASM artifact for the standalone worker bundle. The
// standalone worker (scripts/build-worker-standalone.mjs) bundles every runtime
// dependency into one file so a Box needs no node_modules — but esbuild does not
// carry a `.wasm` into that bundle, and with no node_modules the worker cannot
// `require.resolve` the variant package either. So the bytes must travel beside
// the bundle and the loader is pointed at them via TASK_ORCH_QUICKJS_WASM
// (see lib/codeact/quickjs-variant.ts).
//
// This helper copies the pinned artifact to a destination dir, verifies it
// against the recorded provenance, and writes a `.sha256` sidecar — the same
// "bake the identity next to the artifact" pattern the standalone worker bundle
// uses for its git sha. Used by scripts/build-codeact-wasm-fixture.ts and by
// the offline-load test.

import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolvePackagedWasmPath } from "./quickjs-variant.ts";
import { WASM_ARTIFACT } from "./quickjs-baseline.ts";

export interface PackagedWasm {
  /** Absolute path to the copied .wasm. */
  wasmPath: string;
  /** Absolute path to the sha256 sidecar. */
  shaPath: string;
  /** Verified sha256 of the copied bytes. */
  sha256: string;
}

/**
 * Copy the pinned QuickJS-NG WASM into `destDir`, verify its sha256/size against
 * the recorded provenance, and write a `<file>.sha256` sidecar. Throws if the
 * source artifact does not match provenance — a standalone bundle must never
 * ship engine bytes we did not pin.
 */
export async function packageCodeActWasm(destDir: string): Promise<PackagedWasm> {
  const src = resolvePackagedWasmPath();
  const bytes = await readFile(src);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (bytes.byteLength !== WASM_ARTIFACT.byteLength) {
    throw new Error(
      `QuickJS WASM size ${bytes.byteLength} != pinned ${WASM_ARTIFACT.byteLength}`,
    );
  }
  if (sha256 !== WASM_ARTIFACT.sha256) {
    throw new Error(`QuickJS WASM sha256 ${sha256} != pinned ${WASM_ARTIFACT.sha256}`);
  }

  await mkdir(destDir, { recursive: true });
  const wasmPath = join(destDir, WASM_ARTIFACT.fileName);
  const shaPath = `${wasmPath}.sha256`;
  await copyFile(src, wasmPath);
  await writeFile(shaPath, `${sha256}  ${WASM_ARTIFACT.fileName}\n`);

  return { wasmPath, shaPath, sha256 };
}
