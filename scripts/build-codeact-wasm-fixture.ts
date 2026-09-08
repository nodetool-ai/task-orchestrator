// scripts/build-codeact-wasm-fixture.ts
//
// Copies the pinned QuickJS-NG WASM artifact next to a standalone worker bundle
// so the CodeAct sandbox can load its engine with no node_modules and no
// network. Run standalone (`npm run build:codeact-wasm`) or after the standalone
// worker build; point the worker at the copy with:
//
//   TASK_ORCH_QUICKJS_WASM=dist/codeact/emscripten-module.wasm
//
// Destination defaults to dist/codeact and can be overridden with argv[2].

import { packageCodeActWasm } from "../lib/codeact/wasm-fixture.ts";

const destDir = process.argv[2] ?? "dist/codeact";
const packaged = await packageCodeActWasm(destDir);
console.log(`CodeAct WASM packaged: ${packaged.wasmPath}`);
console.log(`  sha256: ${packaged.sha256}`);
console.log(`  sidecar: ${packaged.shaPath}`);
console.log(`Point the worker at it with TASK_ORCH_QUICKJS_WASM=${packaged.wasmPath}`);
