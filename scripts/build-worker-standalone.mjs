// scripts/build-worker-standalone.mjs
//
// Standalone worker bundle for Box templates (spec:
// docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md §2).
// Unlike `build:worker` (--packages=external, needs a real node_modules at
// runtime), this bundles EVERY runtime dependency into one file so a Box
// needs no node_modules for the worker at all.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { build } from "esbuild";

const SHA_RE = /^[0-9a-f]{40}$/;
const OUTFILE = "dist/run-worker.standalone.js";

// This banner is LOAD-BEARING, not cosmetic. CJS dependencies compiled into
// the ESM bundle (dotenv and others) call require("fs") at runtime, which an
// ESM module cannot satisfy on its own. Removing it makes the bundle throw
// `Dynamic require of "fs" is not supported` at startup.
const banner = [
  'import { createRequire as __cr } from "node:module";',
  "const require = __cr(import.meta.url);",
].join("\n");

await build({
  entryPoints: ["scripts/run-worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { "@": "." },
  // dockerode drags native .node addons (ssh2 → cpu-features) into the graph
  // and is only reached via dynamic `await import("dockerode")` on
  // control-plane dispatch paths a worker never executes (spec §3). Keeping
  // it external is what makes this bundle standalone-clean; do not remove
  // this without first splitting the dispatch seam.
  external: ["dockerode"],
  banner: { js: banner },
  outfile: OUTFILE,
});

// Bake the sha next to the bundle so the control plane can identify exactly
// what bytes this artifact contains without a git/ls-remote round-trip at
// serve time (spec: box-blank-provision final review #1). Resolution: local
// git HEAD first (works in a dev checkout), else GIT_SHA (what the Docker
// build passes in — there is no .git in the docker build context), else skip
// writing the sidecar file entirely.
function resolveBuildSha() {
  try {
    const sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (SHA_RE.test(sha)) return sha;
  } catch {
    // not a git checkout (e.g. docker build context) — fall through
  }
  const envSha = process.env.GIT_SHA?.trim();
  if (envSha && SHA_RE.test(envSha)) return envSha;
  return null;
}

const buildSha = resolveBuildSha();
if (buildSha) {
  writeFileSync(`${OUTFILE}.sha`, `${buildSha}\n`);
}
