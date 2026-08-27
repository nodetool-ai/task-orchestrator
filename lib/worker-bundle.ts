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
export const BUNDLE_ENTRY_PATH = "dist/run-worker.js";

let cached: Promise<{ id: string; tarGz: Buffer }> | undefined;

function load(): Promise<{ id: string; tarGz: Buffer }> {
  cached ??= (async () => {
    const js = await readFile(BUNDLE);
    const id = createHash("sha1").update(js).digest("hex");
    return { id, tarGz: gzipSync(tarSingleFile(BUNDLE_ENTRY_PATH, js), { level: 6 }) };
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
  put(100, oct(0o755, 8));
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
  return Buffer.concat([header, content, Buffer.alloc(pad, 0), Buffer.alloc(1024, 0)]);
}

export async function workerBundleTarGz(): Promise<Buffer> {
  return (await load()).tarGz;
}
