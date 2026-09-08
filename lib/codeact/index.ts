// lib/codeact/index.ts
//
// Public entry point for the CodeAct QuickJS-NG execution foundation
// (plan P-2026-09-07-codeact-migration, milestone T-20260908-0001). This
// milestone establishes the pinned runtime baseline, the dedicated-thread
// execution prototype, and the checked-in operation coverage manifest. It does
// NOT wire CodeAct into any backend — that is later milestones.

export {
  BINDING_PACKAGE,
  BINDING_VERSION,
  VARIANT_PACKAGE,
  VARIANT_VERSION,
  QUICKJS_NG_REVISION,
  WASM_ARTIFACT,
  PACKAGE_INTEGRITY,
} from "./quickjs-baseline.ts";
export {
  WASM_PATH_ENV,
  resolvePackagedWasmPath,
  loadPackagedWasm,
  newCodeActVariant,
  assertWasmMagic,
} from "./quickjs-variant.ts";
export { DEFAULT_LIMITS, resolveLimits, type ExecutionLimits } from "./limits.ts";
export {
  evaluateGuest,
  type EvaluateRequest,
  type EvaluateOutcome,
  type GuestError,
} from "./evaluate.ts";
export {
  executeInThread,
  type ExecuteInThreadOptions,
  type ThreadResult,
} from "./thread.ts";
export { packageCodeActWasm, type PackagedWasm } from "./wasm-fixture.ts";
export {
  OPERATION_MANIFEST,
  summarizeCoverage,
  type OperationEntry,
  type OperationSurface,
  type OperationDomain,
  type CoverageClass,
  type CoverageSummary,
} from "./operation-manifest.ts";
