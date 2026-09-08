// lib/codeact/quickjs-baseline.ts
//
// Pinned QuickJS-NG execution baseline for the CodeAct sandbox
// (plan P-2026-09-07-codeact-migration, "Runtime decision").
//
// This module is the single checked-in source of truth for WHAT engine bytes
// CodeAct runs on. The plan requires that the binding, the exact variant, the
// underlying NG revision, and the WASM artifact provenance are pinned and
// recorded — not left to the binding package's default engine. Everything here
// is asserted against the installed artifact by
// __tests__/codeact-quickjs-baseline.test.ts, so a silent dependency bump that
// changes the engine, the revision, or the WASM bytes fails CI instead of
// shipping.
//
// Human-readable provenance narrative: docs/codeact/quickjs-ng-baseline.md.

/**
 * The binding that hosts the engine. We use `quickjs-emscripten-core`
 * (the engine-less core) and select the variant explicitly below, rather than
 * the batteries-included `quickjs-emscripten` package whose default engine is
 * the original quickjs, not quickjs-ng.
 */
export const BINDING_PACKAGE = "quickjs-emscripten-core";

/** Exact pinned binding version (see package.json — pinned, no caret). */
export const BINDING_VERSION = "0.32.0";

/**
 * The exact variant package. Decoded from its name:
 *   ng        → the quickjs-ng fork (features land faster than upstream qjs)
 *   wasmfile  → ships a separate .wasm artifact (better caching, smaller JS;
 *               lets us load the bytes ourselves with no network)
 *   release   → optimized build (not the debug/asserts build)
 *   sync      → synchronous engine; host callbacks may still return promises,
 *               so Asyncify is unnecessary for the CodeAct bridge (plan
 *               "Runtime decision" / "Promise integration").
 */
export const VARIANT_PACKAGE = "@jitl/quickjs-ng-wasmfile-release-sync";

/** Exact pinned variant version (see package.json — pinned, no caret). */
export const VARIANT_VERSION = "0.32.0";

/**
 * The underlying engine source revision vendored into the variant's WASM.
 * quickjs-ng release tag, as documented by the variant package. Recorded so a
 * security advisory against a specific quickjs-ng tag can be matched to what we
 * actually run without disassembling the artifact.
 */
export const QUICKJS_NG_REVISION = "v0.12.1";

/**
 * Provenance of the packaged WebAssembly artifact shipped inside the variant
 * package at `dist/emscripten-module.wasm`. `sha256` is the hash of those
 * bytes as installed from the pinned version; the baseline test recomputes it
 * from the resolved file and fails on drift.
 */
export const WASM_ARTIFACT = {
  /** Sub-path exported by the variant package that resolves to the .wasm. */
  packageExport: `${VARIANT_PACKAGE}/wasm`,
  /** File name of the artifact inside the package's dist/. */
  fileName: "emscripten-module.wasm",
  /** Byte length of the installed artifact. */
  byteLength: 528551,
  /** SHA-256 of the installed artifact bytes (lowercase hex). */
  sha256: "b56fe5094b8751c47b8c32fb5ed4d75afe2dbb43412d3d983ac5d1156af456da",
  /** WebAssembly binary magic number: the first four bytes are `\0asm`. */
  magic: [0x00, 0x61, 0x73, 0x6d] as const,
} as const;

/** npm registry integrity strings recorded from package-lock.json, so the
 *  pinned tarballs can be verified independently of a live registry. */
export const PACKAGE_INTEGRITY = {
  [BINDING_PACKAGE]:
    "sha512-QFnPfjFey8EqknSrSxe1hZrf1/8z7/6s1QzGOmKo6++02r7QRRX7ZoyNaZh7JuVjWsVW87KnQrbZqnHkOAzUyg==",
  [VARIANT_PACKAGE]:
    "sha512-XAX2jjZWWh3M0YaRqi82xMKNW/gkF6mo3MpW3UY2cmVxnQai1JuboVsJQVoLU629iEL4XWvHtO4h5lo7NRnAcg==",
  "@jitl/quickjs-ffi-types":
    "sha512-v9T+GQpmk43VDJ7d72sf0Nexhk+ArvtUihW27dy7lqAl0zBObFKtSBBIm5RBjwIhE8VwsPPm9PNuvPvNqLWUEg==",
} as const;
