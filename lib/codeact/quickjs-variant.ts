// lib/codeact/quickjs-variant.ts
//
// Loads the pinned QuickJS-NG variant with its packaged WASM bytes, WITHOUT any
// network access. The binding documents configurable WASM loading (plan
// "Runtime decision"); we use it to hand QuickJS the exact `wasmBinary` we read
// off disk, rather than letting the default loader fetch/locate anything.
//
// Two resolution sources, in priority order:
//   1. TASK_ORCH_QUICKJS_WASM env override — an absolute path to the artifact.
//      This is how the standalone worker bundle (which has no node_modules to
//      resolve the package from) points at the .wasm copied next to it.
//   2. Node package resolution of `${VARIANT_PACKAGE}/wasm` — the normal local
//      / installed-dependencies path.
//
// Either way the bytes are read from the local filesystem; nothing here opens a
// socket. Callers that must prove the "no network" property assert against
// {@link WASM_ARTIFACT} provenance and/or run with resolution disabled.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core";
import baseVariant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { WASM_ARTIFACT } from "./quickjs-baseline.ts";

/** Env var that overrides where the packaged .wasm is read from (absolute
 *  path). Used by the standalone worker bundle fixture, which has no
 *  node_modules for `require.resolve` to walk. */
export const WASM_PATH_ENV = "TASK_ORCH_QUICKJS_WASM";

const require = createRequire(import.meta.url);

/**
 * Resolve the absolute path to the packaged QuickJS-NG .wasm artifact without
 * touching the network. Honors {@link WASM_PATH_ENV} first, then falls back to
 * resolving the variant package's `/wasm` export from node_modules.
 */
export function resolvePackagedWasmPath(): string {
  const override = process.env[WASM_PATH_ENV]?.trim();
  if (override) return override;
  return require.resolve(WASM_ARTIFACT.packageExport);
}

/**
 * Read the packaged .wasm bytes off disk. Returns a fresh ArrayBuffer with no
 * network I/O. The slice guards against a Buffer view over a larger pooled
 * allocation so the ArrayBuffer length equals the artifact length.
 */
export async function loadPackagedWasm(path?: string): Promise<ArrayBuffer> {
  const wasmPath = path ?? resolvePackagedWasmPath();
  const buf = await readFile(wasmPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Build the CodeAct QuickJS variant from an explicit WASM binary. Passing
 * `wasmBinary` makes the emscripten loader use those bytes directly and skip
 * any file location / fetch step — the load is fully offline and deterministic.
 */
export function newCodeActVariant(wasmBinary: ArrayBuffer): QuickJSSyncVariant {
  return newVariant(baseVariant, { wasmBinary });
}

/** Assert the loaded bytes are actually a WebAssembly module (`\0asm` magic).
 *  Cheap integrity gate before the bytes reach the engine. */
export function assertWasmMagic(wasmBinary: ArrayBuffer): void {
  const head = new Uint8Array(wasmBinary, 0, 4);
  const [m0, m1, m2, m3] = WASM_ARTIFACT.magic;
  if (head[0] !== m0 || head[1] !== m1 || head[2] !== m2 || head[3] !== m3) {
    throw new Error(
      `CodeAct WASM artifact is not a WebAssembly module (bad magic: ${Array.from(head).join(",")})`,
    );
  }
}
