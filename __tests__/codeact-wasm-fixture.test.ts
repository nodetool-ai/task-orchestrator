import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPackagedWasm,
  resolvePackagedWasmPath,
  assertWasmMagic,
  WASM_PATH_ENV,
} from "../lib/codeact/quickjs-variant";
import { packageCodeActWasm } from "../lib/codeact/wasm-fixture";
import { WASM_ARTIFACT } from "../lib/codeact/quickjs-baseline";
import { executeInThread } from "../lib/codeact/thread";

// AC: "Packaged WASM loads without network access in local and standalone-worker
// build fixtures." Both fixtures load the engine bytes purely from the local
// filesystem (readFile) — no socket is opened — and then actually execute guest
// code with those bytes to prove the load is usable end to end.
describe("CodeAct packaged WASM loading (offline)", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    delete process.env[WASM_PATH_ENV];
    for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it("local fixture: loads the packaged artifact from node_modules and matches provenance", async () => {
    const path = resolvePackagedWasmPath();
    // Resolved to a real local filesystem path, not a URL.
    expect(path.endsWith(WASM_ARTIFACT.fileName)).toBe(true);

    const wasm = await loadPackagedWasm(path);
    expect(wasm.byteLength).toBe(WASM_ARTIFACT.byteLength);
    expect(() => assertWasmMagic(wasm)).not.toThrow();

    // Usable: execute guest code with these exact bytes.
    const result = await executeInThread({ code: "return 6 * 7;", wasmBinary: wasm });
    expect(result).toMatchObject({ status: "ok", value: 42 });
  });

  it("standalone-worker fixture: loads a copied artifact with node_modules resolution unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codeact-standalone-"));
    tmpDirs.push(dir);

    // Package the WASM beside a (hypothetical) standalone bundle, as the build
    // script does.
    const packaged = await packageCodeActWasm(dir);
    expect(packaged.sha256).toBe(WASM_ARTIFACT.sha256);

    // Simulate the standalone worker: point the loader at the copied bytes via
    // the env override, so resolution does NOT walk node_modules.
    process.env[WASM_PATH_ENV] = packaged.wasmPath;
    expect(resolvePackagedWasmPath()).toBe(packaged.wasmPath);

    const wasm = await loadPackagedWasm();
    expect(wasm.byteLength).toBe(WASM_ARTIFACT.byteLength);

    // The copied bytes are a complete, runnable engine.
    const bytesFromCopy = await readFile(packaged.wasmPath);
    const buf = bytesFromCopy.buffer.slice(
      bytesFromCopy.byteOffset,
      bytesFromCopy.byteOffset + bytesFromCopy.byteLength,
    );
    const result = await executeInThread({
      code: "const x = await Promise.resolve(21); return x * 2;",
      wasmBinary: buf,
    });
    expect(result).toMatchObject({ status: "ok", value: 42 });
  });
});
