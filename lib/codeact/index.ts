// lib/codeact/index.ts
//
// Public entry point for the CodeAct QuickJS-NG execution foundation
// (plan P-2026-09-07-codeact-migration, milestone T-20260908-0001). This
// The foundation grew into the production execution bridge and backend
// adapters in later milestones; exports stay centralized here for control-plane
// consumers while worker integrations import database-free modules directly.

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
export { codeActCatalog, codeActCatalogForContext, describeCodeActCatalog, type CatalogLimits } from "./catalog.ts";
export { boundedText, normalizeOutput, type CodeActHandle, type CodeActOutput } from "./output.ts";
export { executeCodeAct, extractCodeActLinks, recoverCodeActExecution, MemoryCodeActReceiptStore, type CodeActExecuteRequest, type CodeActExecuteResult, type CodeActReceiptStore, type CodeActExecutionReceipt, type CodeActSubcallReceipt, type CodeActLink } from "./bridge.ts";
export { codeActModelText, isCodeActPresentation, presentCodeActReceipt, type CodeActPresentation, type CodeActPresentationSubcall } from "./presentation.ts";
export { executeAppCodeAct, type AppCodeActExecuteRequest } from "./app-bridge.ts";
export {
  evaluateGuest,
  type EvaluateRequest,
  type EvaluateOutcome,
  type GuestError,
  type GuestBridge,
  type GuestOutput,
  type GuestDiagnostic,
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
