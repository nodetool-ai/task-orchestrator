// Serve the standalone worker bundle the control plane ships in its own image
// (Dockerfile.server: `npm run build:worker:standalone`) as the tarball the
// sprites bootstrap expects (`curl -fsSL <url> | tar -xz` → dist/run-worker.js).
//
// Identity: the bundle id is the sha1 of the shipped file. Sprites key their
// bootstrap checkpoint on it, so a redeploy with a new bundle re-bootstraps
// and a redeploy with the same bundle skips. No git sha, no sidecar, no
// build arg: whatever this image ships is by definition the right bundle.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const BUNDLE = path.join(process.cwd(), "dist", "run-worker.standalone.js");
const CODEACT_WASM = path.join(process.cwd(), "dist", "codeact", "emscripten-module.wasm");
const CODEACT_WASM_SHA = `${CODEACT_WASM}.sha256`;
const CODEACT_THREAD_WORKER = path.join(process.cwd(), "dist", "codeact", "thread-worker.js");
const PROCESS_SUPERVISOR = path.join(process.cwd(), "dist", "process-supervisor.py");
export const BUNDLE_ENTRY_PATH = "dist/run-worker.js";
export const CODEACT_WASM_ENTRY_PATH = "codeact/emscripten-module.wasm";

let cached: Promise<{ id: string; tarGz: Buffer }> | undefined;

function load(): Promise<{ id: string; tarGz: Buffer }> {
  cached ??= (async () => {
    const [js, wasm, wasmSha, threadWorker, processSupervisor] = await Promise.all([readFile(BUNDLE), readFile(CODEACT_WASM), readFile(CODEACT_WASM_SHA), readFile(CODEACT_THREAD_WORKER), readFile(PROCESS_SUPERVISOR)]);
    const files = [
      { path: BUNDLE_ENTRY_PATH, content: js, mode: 0o755 },
      { path: CODEACT_WASM_ENTRY_PATH, content: wasm, mode: 0o644 },
      { path: `${CODEACT_WASM_ENTRY_PATH}.sha256`, content: wasmSha, mode: 0o644 },
      { path: "codeact/thread-worker.js", content: threadWorker, mode: 0o644 },
      { path: "process-supervisor.py", content: processSupervisor, mode: 0o755 },
    ];
    const identity = createHash("sha1");
    for (const file of files) identity.update(file.path).update("\0").update(file.content);
    return { id: identity.digest("hex"), tarGz: gzipSync(tarFiles(files), { level: 6 }) };
  })().catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

/** sha1 of the shipped bundle. Throws when the image has no bundle. */
export async function workerBundleId(): Promise<string> {
  return (await load()).id;
}

/**
 * Minimal ustar writer: one regular file entry + end-of-archive blocks. Enough
 * for `tar -xz`; avoids a tar dependency for a 30-line format.
 */
export function tarSingleFile(entryPath: string, content: Buffer, mtimeSec = 0): Buffer {
  return tarFiles([{ path: entryPath, content, mode: 0o755 }], mtimeSec);
}

export function tarFiles(files: Array<{ path: string; content: Buffer; mode?: number }>, mtimeSec = 0): Buffer {
  const entries: Buffer[] = [];
  for (const file of files) entries.push(tarEntry(file.path, file.content, file.mode ?? 0o644, mtimeSec));
  return Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
}

function tarEntry(entryPath: string, content: Buffer, mode: number, mtimeSec: number): Buffer {
  const header = Buffer.alloc(512, 0);
  const put = (off: number, s: string) => header.write(s, off, "latin1");
  const oct = (v: number, len: number) => v.toString(8).padStart(len - 1, "0") + "\0";
  const slash = entryPath.indexOf("/");
  // ustar name (100) + prefix (155): split on the first slash when it fits.
  if (entryPath.length > 100 && slash > 0) {
    put(0, entryPath.slice(slash + 1));
    put(345, entryPath.slice(0, slash));
  } else {
    put(0, entryPath);
  }
  put(100, oct(mode, 8));
  put(108, oct(0, 8));
  put(116, oct(0, 8));
  put(124, oct(content.length, 12));
  put(136, oct(mtimeSec, 12));
  put(148, "        "); // checksum placeholder: 8 spaces
  put(156, "0"); // regular file
  put(257, "ustar\0");
  put(263, "00");
  put(265, "root");
  put(297, "root");
  let sum = 0;
  for (const b of header) sum += b;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  const pad = (512 - (content.length % 512)) % 512;
  return Buffer.concat([header, content, Buffer.alloc(pad, 0)]);
}

export async function workerBundleTarGz(): Promise<Buffer> {
  return (await load()).tarGz;
}
