// Serve the standalone worker bundle the control plane ships in its own image
// (Dockerfile.server: `npm run build:worker:standalone`) as the tarball the
// sprites bootstrap expects (`curl -fsSL <url> | tar -xz` → dist/run-worker.js).
//
// Identity: dist/run-worker.standalone.js.sha is baked at build time and must
// equal workerBuildSha() (the pushed tip of the worker repo ref). A request for
// any other sha is refused so a sprite never bootstraps a bundle that does not
// match the code the control plane believes it is running. Deploy with
// `--build-arg GIT_SHA=$(git rev-parse HEAD)` from a pushed commit.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const BUNDLE = path.join(process.cwd(), "dist", "run-worker.standalone.js");
const SHA_FILE = `${BUNDLE}.sha`;
const SHA = /^[0-9a-f]{40}$/;
export const BUNDLE_ENTRY_PATH = "dist/run-worker.js";

export async function shippedWorkerSha(): Promise<string | null> {
  try {
    const sha = (await readFile(SHA_FILE, "utf8")).trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
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
  const js = await readFile(BUNDLE);
  return gzipSync(tarSingleFile(BUNDLE_ENTRY_PATH, js), { level: 6 });
}
