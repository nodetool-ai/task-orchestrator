// scripts/build-worker-standalone.mjs
//
// Standalone worker bundle for Box templates (spec:
// docs/superpowers/specs/2026-07-18-standalone-worker-bundle-design.md §2).
// Unlike `build:worker` (--packages=external, needs a real node_modules at
// runtime), this bundles EVERY runtime dependency into one file so a Box
// needs no node_modules for the worker at all.
import { build } from "esbuild";

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
  outfile: "dist/run-worker.standalone.js",
});
