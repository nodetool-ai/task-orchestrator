# QuickJS-NG execution baseline (CodeAct)

Status: established 2026-09-08 (task T-20260908-0001, plan
`P-2026-09-07-codeact-migration`). This records **what engine bytes CodeAct runs
on** and why, and pins them so a dependency bump cannot silently change the
sandbox. Machine-readable source of truth:
[`lib/codeact/quickjs-baseline.ts`](../../lib/codeact/quickjs-baseline.ts),
asserted by
[`__tests__/codeact-quickjs-baseline.test.ts`](../../__tests__/codeact-quickjs-baseline.test.ts).

## Pinned components

| Component | Value | Where pinned |
| --- | --- | --- |
| Binding | `quickjs-emscripten-core` | `package.json` (exact `0.32.0`, no caret) |
| Variant (engine) | `@jitl/quickjs-ng-wasmfile-release-sync` | `package.json` (exact `0.32.0`, no caret) |
| Underlying engine revision | quickjs-ng **v0.12.1** | vendored into the variant; recorded in `quickjs-baseline.ts` |
| FFI types | `@jitl/quickjs-ffi-types@0.32.0` | transitive, integrity recorded |
| WASM artifact | `dist/emscripten-module.wasm`, 528 551 bytes | sha256 recorded + verified in CI |

WASM artifact sha256:
`b56fe5094b8751c47b8c32fb5ed4d75afe2dbb43412d3d983ac5d1156af456da`.

npm integrity strings for the three pinned packages are captured in
`PACKAGE_INTEGRITY` (`quickjs-baseline.ts`) from `package-lock.json`.

## Why these choices

- **`quickjs-emscripten-core`, not `quickjs-emscripten`.** The batteries-included
  package's default engine is the original quickjs, not quickjs-ng. The core
  package is engine-less and forces an *explicit* variant selection — exactly
  what the plan requires ("Do not rely on the binding package's default
  engine").
- **`ng` variant.** quickjs-ng is the actively-maintained fork; features land
  faster. The migration standardizes on it.
- **`wasmfile`.** Ships the engine as a separate `.wasm` file rather than
  inlining it as base64 in JS. This lets us read the bytes ourselves and hand
  them to the loader (`wasmBinary`), so the load is fully offline and
  deterministic — see below.
- **`release`.** Optimized build, not the debug/asserts build.
- **`sync`.** The synchronous engine. Host callbacks may still return promises,
  so Asyncify is unnecessary for the CodeAct bridge (plan "Promise
  integration"). Guest promises are driven by explicit job pumping instead.

## Offline WASM loading (no network)

`lib/codeact/quickjs-variant.ts` resolves and reads the `.wasm` bytes off the
local filesystem and passes them to `newVariant(base, { wasmBinary })`. Nothing
opens a socket. Resolution order:

1. `TASK_ORCH_QUICKJS_WASM` env override — an absolute path. Used by the
   **standalone worker bundle**, which has no `node_modules` for package
   resolution and instead ships the `.wasm` beside the bundle (see
   `scripts/build-codeact-wasm-fixture.ts` / `npm run build:codeact-wasm`).
2. Node package resolution of `@jitl/quickjs-ng-wasmfile-release-sync/wasm` —
   the normal local / installed-dependencies path.

Both fixtures are covered by
[`__tests__/codeact-wasm-fixture.test.ts`](../../__tests__/codeact-wasm-fixture.test.ts):
the local path loads from `node_modules`; the standalone path packages the
artifact into a temp dir and loads it via the env override with package
resolution unused. In both, the loaded bytes then successfully execute guest
code.

## Verifying / bumping

`npm test` (in CI, with Postgres available) runs the baseline test, which
recomputes the sha256, byte length, and installed versions from disk and fails
on any drift. To intentionally upgrade the engine: bump the pinned versions in
`package.json`, refresh the constants in `quickjs-baseline.ts` (versions,
revision, sha256, byte length, integrity), and review the changelog for the new
quickjs-ng revision.
